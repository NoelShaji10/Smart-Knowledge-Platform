#!/usr/bin/env bash
set -e

echo "Checking container statuses..."
docker compose ps

echo "Pinging health endpoints..."
curl -s http://localhost:3000/health || echo "API Server not running"
curl -s http://localhost:3001/health || echo "Collab Server not running"
curl -s http://localhost:6333/healthz || echo "Qdrant not running"
curl -s http://localhost:4000/health || echo "LiteLLM not running"
