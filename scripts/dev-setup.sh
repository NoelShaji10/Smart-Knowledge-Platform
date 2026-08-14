#!/usr/bin/env bash
set -e

echo "Starting local infrastructure containers..."
docker compose up -d

echo "Waiting for services to become healthy..."
sleep 5

echo "Running PostgreSQL database migrations..."
pnpm db:migrate

echo "Phase 0 infrastructure setup complete."
