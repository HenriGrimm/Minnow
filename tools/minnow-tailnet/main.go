// minnow-tailnet runs a Tailscale node inside Minnow (no system Tailscale
// install) and serves Minnow on the node's HTTPS name, optionally to the public
// internet through Tailscale Funnel so a phone needs nothing installed.
//
// The protocol with Minnow (server/remote/tailnet.js) is documented in README.md.
package main

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"tailscale.com/client/local"
	"tailscale.com/ipn"
	"tailscale.com/tsnet"
)

const featurePollInterval = 3 * time.Second

// machineApprovalURL is where a tailnet admin approves a new device when the
// tailnet has device approval turned on.
const machineApprovalURL = "https://login.tailscale.com/admin/machines"

func main() {
	stateDir := flag.String("state-dir", "", "directory for the node's identity")
	hostname := flag.String("hostname", "minnow", "tailnet machine name")
	targetRaw := flag.String("target", "", "Minnow's trusted loopback listener, e.g. http://127.0.0.1:53111")
	funnel := flag.Bool("funnel", false, "also accept connections from the public internet (Tailscale Funnel)")
	flag.Parse()

	events := NewEmitter(os.Stdout)
	fail := func(code string, err error) {
		events.Emit(Event{Event: "error", Code: code, Message: err.Error()})
		os.Exit(1)
	}

	secret := os.Getenv("MINNOW_INGRESS_SECRET")
	if *stateDir == "" || *targetRaw == "" || secret == "" {
		fail("bad-arguments", errors.New("--state-dir, --target and MINNOW_INGRESS_SECRET are required"))
	}
	target, err := url.Parse(*targetRaw)
	if err != nil || target.Scheme != "http" {
		fail("bad-arguments", fmt.Errorf("invalid --target %q", *targetRaw))
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	verbose := os.Getenv("MINNOW_TAILNET_VERBOSE") == "1"
	server := &tsnet.Server{
		Dir:      *stateDir,
		Hostname: *hostname,
		Logf: func(format string, args ...any) {
			if verbose {
				log.Printf(format, args...)
			}
		},
		UserLogf: func(format string, args ...any) { log.Printf(format, args...) },
	}
	events.Emit(Event{Event: "starting"})
	if err := server.Start(); err != nil {
		fail("start-failed", err)
	}
	defer server.Close()

	go watchStdin(ctx, cancel, server, events)
	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
		<-signals
		cancel()
	}()

	if err := run(ctx, server, target, secret, *funnel, events); err != nil && !errors.Is(err, context.Canceled) {
		fail("run-failed", err)
	}
	events.Emit(Event{Event: "stopped"})
}

// run waits for sign-in and tailnet approvals, then serves until ctx ends.
func run(ctx context.Context, server *tsnet.Server, target *url.URL, secret string, funnel bool, events *Emitter) error {
	lc, err := server.LocalClient()
	if err != nil {
		return err
	}

	if err := waitForLogin(ctx, server, events); err != nil {
		return err
	}

	// HTTPS certificates (the "serve" feature) and, for phones without the
	// Tailscale app, Funnel must be allowed by the tailnet's owner once.
	features := []string{"serve"}
	if funnel {
		features = append(features, "funnel")
	}
	for _, feature := range features {
		if err := waitForFeature(ctx, server, feature, events); err != nil {
			return err
		}
	}

	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil {
		return err
	}
	if status.Self == nil || status.Self.DNSName == "" {
		return errors.New("Tailscale did not assign a DNS name; turn on MagicDNS for your tailnet")
	}
	dnsName := strings.TrimSuffix(status.Self.DNSName, ".")

	// Fetch the certificate now so the first phone request is not the one
	// that waits for Let's Encrypt.
	certCtx, certCancel := context.WithTimeout(ctx, 90*time.Second)
	_, _, certErr := lc.CertPair(certCtx, dnsName)
	certCancel()
	if certErr != nil {
		events.Emit(Event{Event: "error", Code: "cert-failed", Message: certErr.Error()})
	}

	// Offer HTTP/2: the dev server sends hundreds of separate modules, and over
	// HTTP/1.1 a browser fetches them six at a time, one tailnet round trip each.
	// WebSockets still arrive over HTTP/1.1 (Go leaves extended CONNECT off).
	tlsConfig := &tls.Config{
		GetCertificate: lc.GetCertificate,
		NextProtos:     []string{"h2", "http/1.1"},
	}
	var listener net.Listener
	if funnel {
		listener, err = server.ListenFunnel("tcp", ":443", tsnet.FunnelTLSConfig(tlsConfig))
	} else {
		var raw net.Listener
		raw, err = server.Listen("tcp", ":443")
		if err == nil {
			listener = tls.NewListener(raw, tlsConfig)
		}
	}
	if err != nil {
		return err
	}
	defer listener.Close()

	whoIs := func(ctx context.Context, remoteAddr string) string {
		who, err := lc.WhoIs(ctx, remoteAddr)
		if err != nil || who == nil || who.UserProfile == nil {
			return ""
		}
		return who.UserProfile.LoginName
	}
	httpServer := &http.Server{
		Handler:           NewProxy(target, secret, whoIs),
		ReadHeaderTimeout: 30 * time.Second,
		ConnContext: func(ctx context.Context, conn net.Conn) context.Context {
			return WithConnInfo(ctx, describeConn(conn))
		},
	}

	loginName := ""
	tailnet := ""
	if status.CurrentTailnet != nil {
		tailnet = status.CurrentTailnet.Name
	}
	if profile, ok := status.User[status.Self.UserID]; ok {
		loginName = profile.LoginName
	}
	funnelOn := funnel
	events.Emit(Event{
		Event:     "ready",
		DNSName:   dnsName,
		URL:       "https://" + dnsName + "/",
		Funnel:    &funnelOn,
		LoginName: loginName,
		Tailnet:   tailnet,
	})

	serveErr := make(chan error, 1)
	go func() { serveErr <- httpServer.Serve(listener) }()
	select {
	case <-ctx.Done():
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer shutdownCancel()
		_ = httpServer.Shutdown(shutdownCtx)
		return ctx.Err()
	case err := <-serveErr:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

// describeConn classifies a connection accepted by the Funnel/TLS listener.
func describeConn(conn net.Conn) ConnInfo {
	raw := conn
	if tlsConn, ok := conn.(*tls.Conn); ok {
		raw = tlsConn.NetConn()
	}
	if funnelConn, ok := raw.(*ipn.FunnelConn); ok {
		return ConnInfo{Funnel: true, ClientIP: funnelConn.Src.Addr().String()}
	}
	return ConnInfo{Funnel: false, ClientIP: remoteIP(conn.RemoteAddr().String())}
}

// waitForLogin reports the sign-in URL until the node is running.
func waitForLogin(ctx context.Context, server *tsnet.Server, events *Emitter) error {
	lc, err := server.LocalClient()
	if err != nil {
		return err
	}
	watcher, err := lc.WatchIPNBus(ctx, ipn.NotifyInitialState)
	if err != nil {
		return err
	}
	defer watcher.Close()
	for {
		notify, err := watcher.Next()
		if err != nil {
			return err
		}
		if notify.ErrMessage != nil && *notify.ErrMessage != "" {
			events.Emit(Event{Event: "error", Code: "tailscale", Message: *notify.ErrMessage})
		}
		if notify.BrowseToURL != nil && *notify.BrowseToURL != "" {
			events.Emit(Event{Event: "needs-login", AuthURL: *notify.BrowseToURL})
		}
		if notify.State != nil {
			switch *notify.State {
			case ipn.Running:
				// Clear any sign-in or approval prompt while features are checked.
				events.Emit(Event{Event: "starting"})
				return nil
			case ipn.NeedsMachineAuth:
				// The tailnet requires an admin to approve new devices.
				events.Emit(Event{Event: "needs-approval", Feature: "device", URL: machineApprovalURL, LoginName: currentLogin(ctx, lc)})
			case ipn.NeedsLogin:
				// tsnet starts an interactive login when no auth key is set;
				// the URL arrives in a later BrowseToURL notification.
			}
		}
	}
}

// currentLogin names the Tailscale account the node is signed in to, so a
// wrong account is visible before setup finishes.
func currentLogin(ctx context.Context, lc *local.Client) string {
	status, err := lc.StatusWithoutPeers(ctx)
	if err != nil || status.Self == nil {
		return ""
	}
	if profile, ok := status.User[status.Self.UserID]; ok {
		return profile.LoginName
	}
	return ""
}

// waitForFeature blocks until the tailnet allows a feature, reporting the
// approval page while it does not.
func waitForFeature(ctx context.Context, server *tsnet.Server, feature string, events *Emitter) error {
	lc, err := server.LocalClient()
	if err != nil {
		return err
	}
	label := "https"
	if feature == "funnel" {
		label = "funnel"
	}
	for {
		response, err := lc.QueryFeature(ctx, feature)
		if err != nil {
			return fmt.Errorf("checking %s: %w", feature, err)
		}
		if response.Complete {
			return nil
		}
		events.Emit(Event{Event: "needs-approval", Feature: label, URL: response.URL, Message: response.Text})
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(featurePollInterval):
		}
	}
}

type command struct {
	Cmd string `json:"cmd"`
}

// watchStdin handles commands from Minnow; EOF means Minnow went away.
func watchStdin(ctx context.Context, cancel context.CancelFunc, server *tsnet.Server, events *Emitter) {
	reader := bufio.NewReader(os.Stdin)
	for {
		line, err := reader.ReadString('\n')
		if strings.TrimSpace(line) != "" {
			var cmd command
			if json.Unmarshal([]byte(line), &cmd) == nil && cmd.Cmd == "logout" {
				if lc, lcErr := server.LocalClient(); lcErr == nil {
					logoutCtx, logoutCancel := context.WithTimeout(ctx, 10*time.Second)
					_ = lc.Logout(logoutCtx)
					logoutCancel()
				}
				events.Emit(Event{Event: "stopped"})
				cancel()
				return
			}
		}
		if err != nil {
			if !errors.Is(err, io.EOF) {
				log.Printf("stdin: %v", err)
			}
			cancel()
			return
		}
	}
}
