package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"path"
	"strings"

	"github.com/go-chi/chi"
	"github.com/gorilla/websocket"
	"github.com/peer-calls/peer-calls/v4/server/identifiers"
	"github.com/peer-calls/peer-calls/v4/server/logger"
	"github.com/peer-calls/peer-calls/v4/server/pubsub"
	"github.com/peer-calls/peer-calls/v4/server/sfu"
	"github.com/peer-calls/peer-calls/v4/server/transport"
	"github.com/peer-calls/peer-calls/v4/server/uuid"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

func buildManifest(baseURL string) []byte {
	b, _ := json.Marshal(map[string]interface{}{
		"name":             "Peer Calls",
		"short_name":       "Peer Calls",
		"start_url":        baseURL,
		"display":          "standalone",
		"background_color": "#086788",
		"description":      "Group peer-to-peer calls for everyone. Create a private room. Share the link.",
		"icons": []map[string]string{{
			"src":   baseURL + "/res/icon.png",
			"sizes": "256x256",
			"type":  "image/png",
		}},
	})
	return b
}

type Mux struct {
	BaseURL                  string
	handler                  *chi.Mux
	iceServers               []ICEServer
	network                  NetworkConfig
	version                  string
	encodedInsertableStreams bool
}

func (mux *Mux) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	mux.handler.ServeHTTP(w, r)
}

type TracksManager interface {
	Add(room identifiers.RoomID, transport transport.Transport) (<-chan pubsub.PubTrackEvent, error)
	Sub(params sfu.SubParams) error
	Unsub(params sfu.SubParams) error
}

func withGauge(counter prometheus.Counter, h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		counter.Inc()
		h.ServeHTTP(w, r)
	}
}

type RoomManager interface {
	Enter(room identifiers.RoomID) (adapter Adapter, isNew bool)
	Exit(room identifiers.RoomID) (isRemoved bool)
}

var clientUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func subtitleProxyHandler(w http.ResponseWriter, r *http.Request) {
	subtitleURL := os.Getenv("SUBTITLE_WS_URL")
	if subtitleURL == "" {
		subtitleURL = "http://localhost:8765"
	}

	// Convert http(s) to ws(s) for the backend dial
	wsBackendURL := strings.Replace(subtitleURL, "https://", "wss://", 1)
	wsBackendURL = strings.Replace(wsBackendURL, "http://", "ws://", 1)
	wsBackendURL = wsBackendURL + "/subtitles"

	// Dial the backend (ngrok → Colab)
	backendHeader := http.Header{
		"ngrok-skip-browser-warning": []string{"true"},
	}
	backendConn, _, err := websocket.DefaultDialer.Dial(wsBackendURL, backendHeader)
	if err != nil {
		log.Printf("[subtitles] backend dial error: %v", err)
		http.Error(w, "subtitle server unavailable", http.StatusBadGateway)
		return
	}
	defer backendConn.Close()

	// Upgrade the browser connection to WebSocket
	clientConn, err := clientUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("[subtitles] client upgrade error: %v", err)
		return
	}
	defer clientConn.Close()

	// Pipe messages in both directions
	errc := make(chan error, 2)

	// Browser → Colab (config messages + audio binary)
	go func() {
		for {
			mt, msg, err := clientConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if err = backendConn.WriteMessage(mt, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	// Colab → Browser (subtitle JSON messages)
	go func() {
		for {
			mt, msg, err := backendConn.ReadMessage()
			if err != nil {
				errc <- err
				return
			}
			if err = clientConn.WriteMessage(mt, msg); err != nil {
				errc <- err
				return
			}
		}
	}()

	// Wait until one side disconnects
	if err := <-errc; err != nil && err != io.EOF {
		log.Printf("[subtitles] proxy closed: %v", err)
	}
}

func NewMux(
	log logger.Logger,
	baseURL string,
	version string,
	network NetworkConfig,
	iceServers []ICEServer,
	encodedInsertableStreams bool,
	rooms RoomManager,
	tracks TracksManager,
	prom PrometheusConfig,
	embed Embed,
) *Mux {
	log = log.WithNamespaceAppended("mux")

	templates := ParseTemplates(embed.Templates)
	renderer := NewRenderer(log, templates, baseURL, version)

	handler := chi.NewRouter()
	mux := &Mux{
		BaseURL:                  baseURL,
		handler:                  handler,
		iceServers:               iceServers,
		network:                  network,
		version:                  version,
		encodedInsertableStreams: encodedInsertableStreams,
	}

	var root string
	if baseURL == "" {
		root = "/"
	} else {
		root = baseURL
	}

	wsHandler := newWebSocketHandler(
		log,
		network,
		NewWSS(log, rooms),
		iceServers,
		tracks,
	)

	manifest := buildManifest(baseURL)
	handler.Route(root, func(router chi.Router) {
		router.Get("/", withGauge(prometheusHomeViewsTotal, renderer.Render(mux.routeIndex)))
		router.Handle("/static/*", static(baseURL+"/static", embed.Static))
		router.Handle("/res/*", static(baseURL+"/res", embed.Resources))
		router.Post("/call", withGauge(prometheusCallJoinTotal, mux.routeNewCall))
		router.Get("/call/{callID}", withGauge(prometheusCallViewsTotal, renderer.Render(mux.routeCall)))
		router.Get("/probes/liveness", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
		})
		router.Get("/probes/health", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
		})
		router.Get("/manifest.json", func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Write(manifest)
		})
		router.Get("/metrics", func(w http.ResponseWriter, r *http.Request) {
			accessToken := r.Header.Get("Authorization")
			if strings.HasPrefix(accessToken, "Bearer ") {
				accessToken = accessToken[len("Bearer "):]
			} else {
				accessToken = r.FormValue("access_token")
			}

			if accessToken == "" || accessToken != prom.AccessToken {
				w.WriteHeader(http.StatusUnauthorized)
				return
			}
			promhttp.Handler().ServeHTTP(w, r)
		})

		router.Mount("/ws", wsHandler)
		router.Get("/subtitles", subtitleProxyHandler)
	})

	return mux
}

func newWebSocketHandler(
	log logger.Logger,
	network NetworkConfig,
	wss *WSS,
	iceServers []ICEServer,
	tracks TracksManager,
) http.Handler {
	log = log.WithNamespaceAppended("websocket_handler")

	switch network.Type {
	case NetworkTypeSFU:
		log.Info("Using network type sfu", nil)
		return NewSFUHandler(log, wss, iceServers, network.SFU, tracks)
	case NetworkTypeMesh:
		fallthrough
	default:
		log.Info("Using network type mesh", nil)
		return NewMeshHandler(log, wss)
	}
}

func static(prefix string, box fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(box))
	return http.StripPrefix(prefix, fileServer)
}

func (mux *Mux) routeNewCall(w http.ResponseWriter, r *http.Request) {
	callID := r.PostFormValue("call")
	if callID == "" {
		callID = uuid.New()
	}

	url := mux.BaseURL + "/call/" + url.PathEscape(callID)
	http.Redirect(w, r, url, http.StatusFound)
}

func (mux *Mux) routeIndex(w http.ResponseWriter, r *http.Request) (string, interface{}, error) {
	data := mux.getData()
	return "index.html", data, nil
}

func (mux *Mux) getData() map[string]interface{} {
	return map[string]interface{}{
		"BaseURL": mux.BaseURL,
		"Version": mux.version,
	}
}

func (mux *Mux) routeCall(w http.ResponseWriter, r *http.Request) (string, interface{}, error) {
	callID := url.PathEscape(path.Base(r.URL.Path))
	peerID := uuid.New()
	iceServers := GetICEAuthServers(mux.iceServers)

	config := ClientConfig{
		BaseURL:  mux.BaseURL,
		Nickname: r.Header.Get("X-Forwarded-User"),
		CallID:   callID,
		PeerID:   peerID,
		PeerConfig: PeerConfig{
			ICEServers:               iceServers,
			EncodedInsertableStreams: mux.encodedInsertableStreams,
		},
		Network: mux.network.Type,
	}

	configJSON, _ := json.Marshal(config)
	return "call.html", string(configJSON), nil
}