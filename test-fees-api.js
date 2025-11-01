// Test fees API
import http from 'http';

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/fees?is_offline=false',
  method: 'GET'
};

const req = http.request(options, (res) => {
  let data = '';

  res.on('data', (chunk) => {
    data += chunk;
  });

  res.on('end', () => {
    try {
      const json = JSON.parse(data);
      console.log('Number of records:', json.length);
      if (json.length > 0) {
        console.log('\nFirst record:');
        console.log(JSON.stringify(json[0], null, 2));
      }
    } catch (e) {
      console.log('Raw response:', data);
    }
  });
});

req.on('error', (error) => {
  console.error('Error:', error);
});

req.end();
