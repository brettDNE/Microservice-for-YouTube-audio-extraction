# Use official Node.js runtime as base image
FROM node:18-alpine

# Install system dependencies for youtube-dl and ffmpeg
RUN apk add --no-cache ffmpeg python3 py3-pip

# Install youtube-dl
RUN pip3 install youtube-dl

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install Node.js dependencies
RUN npm install

# Copy application code
COPY . .

# Expose port 
EXPOSE 8080

# Environment variable for port
ENV PORT=8080

# Command to start the service
CMD ["npm", "start"]
