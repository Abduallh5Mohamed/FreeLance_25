import base64
import sys
import subprocess

# Read the JS file
with open(r"D:\Freelance10\FreeLance_25-1\dist\assets\index-C-cVA6e9.js", "rb") as f:
    content = f.read()

# Convert to base64
b64 = base64.b64encode(content).decode('ascii')

# Upload in chunks via SSH
chunk_size = 20000
total_chunks = (len(b64) + chunk_size - 1) // chunk_size

# Clear the target file
subprocess.run(["ssh", "root@72.62.35.177", "rm -f /tmp/jsfile.b64"], input=b"MyPass12345@\n")

for i in range(total_chunks):
    start = i * chunk_size
    end = min(start + chunk_size, len(b64))
    chunk = b64[start:end]
    
    cmd = f"echo -n '{chunk}' >> /tmp/jsfile.b64"
    subprocess.run(["ssh", "root@72.62.35.177", cmd], input=b"MyPass12345@\n")
    print(f"Uploaded {i+1}/{total_chunks}")

# Decode on server
subprocess.run(["ssh", "root@72.62.35.177", "base64 -d /tmp/jsfile.b64 > /var/www/alqaed-platform/dist/assets/index-C-cVA6e9.js && ls -lh /var/www/alqaed-platform/dist/assets/index-C-cVA6e9.js"], input=b"MyPass12345@\n")
