package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
)

// ConnInfo describes who is on the other end of one accepted connection.
type ConnInfo struct {
	// Funnel is true for connections from the public internet via Tailscale
	// Funnel, false for peers inside the tailnet.
	Funnel bool
	// ClientIP is the real client address (Funnel source, or tailnet peer IP).
	ClientIP string
}

type connInfoKey struct{}

// WithConnInfo attaches connection identity to a request context.
func WithConnInfo(ctx context.Context, info ConnInfo) context.Context {
	return context.WithValue(ctx, connInfoKey{}, info)
}

func connInfoFrom(ctx context.Context) ConnInfo {
	info, _ := ctx.Value(connInfoKey{}).(ConnInfo)
	return info
}

// WhoIsFunc resolves a tailnet peer's login name (empty when unknown).
type WhoIsFunc func(ctx context.Context, remoteAddr string) string

// NewProxy forwards every request to Minnow's trusted loopback listener. It
// strips anything a client might send to impersonate this proxy, then adds the
// per-boot secret and the ingress kind so Minnow can tell Funnel from tailnet
// traffic. The browser's Host header is preserved; Minnow validates it.
func NewProxy(target *url.URL, secret string, whoIs WhoIsFunc) http.Handler {
	proxy := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.Out.Host = pr.In.Host
			for name := range pr.Out.Header {
				lower := strings.ToLower(name)
				if strings.HasPrefix(lower, "x-minnow-") || strings.HasPrefix(lower, "x-forwarded-") || lower == "forwarded" {
					pr.Out.Header.Del(name)
				}
			}
			info := connInfoFrom(pr.In.Context())
			kind := "tailnet"
			if info.Funnel {
				kind = "funnel"
			}
			pr.Out.Header.Set("X-Minnow-Ingress-Secret", secret)
			pr.Out.Header.Set("X-Minnow-Ingress", kind)
			if info.ClientIP != "" {
				pr.Out.Header.Set("X-Forwarded-For", info.ClientIP)
			}
			if !info.Funnel && whoIs != nil {
				if login := whoIs(pr.In.Context(), pr.In.RemoteAddr); login != "" {
					pr.Out.Header.Set("X-Minnow-Tailnet-User", login)
				}
			}
		},
		// Stream server-sent events and token streams without buffering.
		FlushInterval: -1,
		ErrorHandler: func(w http.ResponseWriter, _ *http.Request, _ error) {
			w.WriteHeader(http.StatusBadGateway)
			_, _ = w.Write([]byte("Minnow is not responding"))
		},
	}
	return proxy
}

// remoteIP returns the host part of an address, or the input unchanged.
func remoteIP(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}
