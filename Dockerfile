# Use Node.js 18 slim image
FROM node:18-slim

# Install git (required for some npm packages)
RUN apt-get update && apt-get install -y git && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy app source code
COPY . .

# Create directories for WhatsApp auth sessions
RUN mkdir -p ./auth

# Expose port
EXPOSE 8080

# Start the application
CMD ["npm", "start"]
