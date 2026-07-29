# Serves the Granboard Scorer static files behind nginx.
#
# Note: Web Bluetooth still requires a secure context in the browser. If
# you're accessing this over the network (not localhost), put it behind
# HTTPS (e.g. a reverse proxy with a TLS cert) or Chrome/Edge will refuse
# to expose navigator.bluetooth.

FROM nginx:alpine

COPY index.html granboard.js game.js online.js scoring.js webrtc.js /usr/share/nginx/html/

EXPOSE 80
