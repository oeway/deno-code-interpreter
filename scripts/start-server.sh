#!/bin/bash

# Check if Deno is installed
if ! command -v deno &> /dev/null; then
    echo "Deno is not installed. Please install Deno first:"
    echo "Visit https://deno.land/#installation for installation instructions"
    exit 1
fi

# Start the server with necessary permissions
echo "Starting Deno App Engine server..."
deno run  --allow-ffi --allow-net --allow-read --allow-write --allow-env scripts/server.ts 