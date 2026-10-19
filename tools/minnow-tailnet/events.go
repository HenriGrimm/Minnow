package main

import (
	"encoding/json"
	"io"
	"sync"
)

// Event is one line of the stdout protocol read by server/remote/tailnet.js.
type Event struct {
	Event     string `json:"event"`
	AuthURL   string `json:"authUrl,omitempty"`
	Feature   string `json:"feature,omitempty"`
	URL       string `json:"url,omitempty"`
	DNSName   string `json:"dnsName,omitempty"`
	Funnel    *bool  `json:"funnel,omitempty"`
	LoginName string `json:"loginName,omitempty"`
	Tailnet   string `json:"tailnet,omitempty"`
	Code      string `json:"code,omitempty"`
	Message   string `json:"message,omitempty"`
}

// Emitter writes events as newline-delimited JSON, one write per event.
type Emitter struct {
	mu   sync.Mutex
	out  io.Writer
	last string
}

func NewEmitter(out io.Writer) *Emitter {
	return &Emitter{out: out}
}

// Emit writes the event unless it repeats the previous one verbatim, so
// polling loops do not flood the parent with identical status lines.
func (e *Emitter) Emit(ev Event) {
	line, err := json.Marshal(ev)
	if err != nil {
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if string(line) == e.last {
		return
	}
	e.last = string(line)
	_, _ = e.out.Write(append(line, '\n'))
}
