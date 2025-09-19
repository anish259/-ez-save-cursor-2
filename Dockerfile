# Use Ubuntu as base image for better package support
FROM ubuntu:22.04

# Set environment variables
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_VERSION=18

# Install system dependencies
RUN apt-get update && apt-get install -y \
    curl \
    wget \
    ca-certificates \
    python3 \
    python3-pip \
    ffmpeg \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN pip3 install yt-dlp

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
    && apt-get install -y nodejs

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install Node.js dependencies
RUN npm ci --only=production

# Copy application files
COPY . .

# Create non-root user for security
RUN useradd -m -u 1001 appuser && chown -R appuser:appuser /app
USER appuser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

# Start the application
CMD ["npm", "start"]
