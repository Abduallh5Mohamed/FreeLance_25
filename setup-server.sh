sudo apt update
sudo apt install -y nginx ufw
sudo ufw allow 22/tcp
sudo ufw allow 80/tcp  
sudo ufw allow 443/tcp
sudo ufw --force enable
sudo mkdir -p /var/www/alqaed-platform
echo 'Setup complete'
