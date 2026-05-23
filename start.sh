#!/bin/bash

# tmuxU Development Server Starter

echo "Starting tmuxU development servers..."

if command -v tailscale >/dev/null 2>&1; then
  TAILSCALE_IP=$(tailscale ip -4 2>/dev/null | head -n 1)
fi
if [ -z "$TAILSCALE_IP" ]; then
  TAILSCALE_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
fi
if [ -z "$TAILSCALE_IP" ]; then
  TAILSCALE_IP="localhost"
fi

# Kill existing processes
pkill -f "next dev" 2>/dev/null
pkill -f "tsx watch" 2>/dev/null
sleep 1

# Start Gateway
echo "Starting Gateway on port 3001..."
HOST=0.0.0.0 npm run dev:gateway > /tmp/tmuxu-gateway.log 2>&1 &
GATEWAY_PID=$!

# Wait for Gateway to start
sleep 2

# Start Frontend
echo "Starting Frontend on port 3000..."
NEXT_PUBLIC_API_URL="http://${TAILSCALE_IP}:3001" HOST=0.0.0.0 npm run dev:frontend > /tmp/tmuxu-frontend.log 2>&1 &
FRONTEND_PID=$!

echo ""
echo "tmuxU is starting up..."
echo ""
echo "  Frontend:  http://${TAILSCALE_IP}:3000"
echo "  Gateway:   http://${TAILSCALE_IP}:3001"
echo ""
echo "Logs:"
echo "  Gateway:   /tmp/tmuxu-gateway.log"
echo "  Frontend:  /tmp/tmuxu-frontend.log"
echo ""
echo "Press Ctrl+C to stop all services"

# Wait for interrupt
trap "kill $GATEWAY_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
