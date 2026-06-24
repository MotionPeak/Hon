#!/usr/bin/env bash
# Boots the virtual-display + VNC stack, then the engine. Used only in the
# container (the Mac runs the engine directly with a real local display).
set -euo pipefail

export DISPLAY=:99

# 1280x960 matches the pension window size; 24-bit depth for a normal browser.
Xvfb :99 -screen 0 1280x960x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
# Wait for the display socket so Chrome never races Xvfb.
for i in $(seq 1 50); do [ -e /tmp/.X11-unix/X99 ] && break; sleep 0.1; done

# Serve the framebuffer over VNC on localhost only (the engine proxies it).
x11vnc -display :99 -localhost -nopw -forever -shared -quiet >/tmp/x11vnc.log 2>&1 &
# websockify serves the noVNC client (--web) AND bridges WS->VNC, localhost only.
websockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/tmp/websockify.log 2>&1 &

# The engine is the foreground process; when it exits, the container exits.
exec node --import tsx src/server.ts
