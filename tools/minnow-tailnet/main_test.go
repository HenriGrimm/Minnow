package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"
)

func proxyTo(t *testing.T, upstream http.Handler, info ConnInfo, whoIs WhoIsFunc) *httptest.Server {
	t.Helper()
	backend := httptest.NewServer(upstream)
	t.Cleanup(backend.Close)
	target, _ := url.Parse(backend.URL)
	proxy := NewProxy(target, "per-boot-secret", whoIs)
	front := httptest.NewUnstartedServer(proxy)
	front.Config.ConnContext = func(ctx context.Context, _ net.Conn) context.Context { return WithConnInfo(ctx, info) }
	front.Start()
	t.Cleanup(front.Close)
	return front
}

func TestProxyReplacesClientSuppliedSecretAndMarksFunnel(t *testing.T) {
	var got http.Header
	var host string
	front := proxyTo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
		host = r.Host
	}), ConnInfo{Funnel: true, ClientIP: "203.0.113.7"}, nil)

	req, _ := http.NewRequest(http.MethodGet, front.URL+"/api/auth/host-info", nil)
	req.Host = "minnow-studio.tail1.ts.net"
	req.Header.Set("X-Minnow-Ingress-Secret", "attacker")
	req.Header.Set("X-Minnow-Ingress", "loopback")
	req.Header.Set("X-Forwarded-For", "10.0.0.1")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()

	if v := got.Get("X-Minnow-Ingress-Secret"); v != "per-boot-secret" {
		t.Fatalf("secret = %q", v)
	}
	if v := got.Get("X-Minnow-Ingress"); v != "funnel" {
		t.Fatalf("ingress = %q", v)
	}
	if v := got.Get("X-Forwarded-For"); v != "203.0.113.7" {
		t.Fatalf("forwarded-for = %q", v)
	}
	if host != "minnow-studio.tail1.ts.net" {
		t.Fatalf("host = %q", host)
	}
}

func TestProxyTagsTailnetPeersWithTheirLogin(t *testing.T) {
	var got http.Header
	front := proxyTo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got = r.Header.Clone()
	}), ConnInfo{Funnel: false, ClientIP: "100.101.102.103"}, func(context.Context, string) string {
		return "henri@example.com"
	})
	res, err := http.Get(front.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	res.Body.Close()
	if v := got.Get("X-Minnow-Ingress"); v != "tailnet" {
		t.Fatalf("ingress = %q", v)
	}
	if v := got.Get("X-Minnow-Tailnet-User"); v != "henri@example.com" {
		t.Fatalf("user = %q", v)
	}
}

func TestProxyStreamsServerSentEvents(t *testing.T) {
	release := make(chan struct{})
	front := proxyTo(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: first\n\n")
		w.(http.Flusher).Flush()
		<-release
		fmt.Fprint(w, "data: second\n\n")
	}), ConnInfo{Funnel: true}, nil)

	res, err := http.Get(front.URL + "/api/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	reader := bufio.NewReader(res.Body)
	lineCh := make(chan string, 1)
	go func() {
		line, _ := reader.ReadString('\n')
		lineCh <- line
	}()
	select {
	case line := <-lineCh:
		if strings.TrimSpace(line) != "data: first" {
			t.Fatalf("first line = %q", line)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("first event was buffered instead of streamed")
	}
	close(release)
}

func TestEmitterWritesOneJSONLinePerEventAndSkipsRepeats(t *testing.T) {
	var out bytes.Buffer
	events := NewEmitter(&out)
	funnel := true
	events.Emit(Event{Event: "needs-login", AuthURL: "https://login.tailscale.com/a/x"})
	events.Emit(Event{Event: "needs-login", AuthURL: "https://login.tailscale.com/a/x"})
	events.Emit(Event{Event: "ready", DNSName: "minnow-studio.tail1.ts.net", Funnel: &funnel})

	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	if len(lines) != 2 {
		t.Fatalf("lines = %d: %q", len(lines), out.String())
	}
	var ready map[string]any
	if err := json.Unmarshal([]byte(lines[1]), &ready); err != nil {
		t.Fatal(err)
	}
	if ready["event"] != "ready" || ready["dnsName"] != "minnow-studio.tail1.ts.net" || ready["funnel"] != true {
		t.Fatalf("ready = %v", ready)
	}
	if _, present := ready["authUrl"]; present {
		t.Fatal("empty fields must be omitted")
	}
}
