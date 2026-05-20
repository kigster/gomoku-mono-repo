# Stage 1: The Builder
# Use the specified Ubuntu LTS (22.04) as the base image.
# Use the official Rust image from Docker Hub
FROM rust:latest

# Install all necessary build dependencies. `build-essential` includes gcc and make.
RUN apt-get update && apt-get install -y build-essential git just

# Set the working directory inside the container to /app. This is where the source code will be copied and built.
WORKDIR /app

# Copy the entire project source code into the container.
COPY . .

# from the host machine. This ensures a clean build from source inside the container.
RUN just build-release

# Expose the ports that the application will listen on.
# 8787: HTTP API port
# 8788: HAProxy agent-check port
EXPOSE 8787 8788

# Set the final command to run when the container starts.
# This starts the Gomoku HTTP daemon with:
# - HTTP API on port 8787
# - HAProxy agent-check on port 8788 (reports ready/drain status)
CMD ["./bin/gomoku-httpd", "-b", "0.0.0.0:8787", "-a", "8788", "-r", "-L", "debug"]

