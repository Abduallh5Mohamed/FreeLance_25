#!/bin/bash
# Server setup script - run on VPS

echo "Updating system..."
sudo apt update

echo "Installing Nginx..."
sudo apt install -y nginx

echo "Installing UFW firewall..."
sudo apt install -y ufw

echo "Configuring firewall..."
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw --force enable

echo "Creating project directory..."
sudo mkdir -p /var/www/alqaed-platform

echo "Server setup complete!"
echo "Next: Upload dist folder and configure Nginx"
