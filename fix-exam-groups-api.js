// Fix exam groups via API
// Run: node fix-exam-groups-api.js

const https = require('https');
const http = require('http');

const BASE_URL = 'https://elka2d.cloud/api';

async function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { rejectUnauthorized: false }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

async function postJson(url, body) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(url);
        const options = {
            hostname: urlObj.hostname,
            port: urlObj.port || 443,
            path: urlObj.pathname,
            method: 'POST',
            rejectUnauthorized: false,
            headers: {
                'Content-Type': 'application/json',
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    resolve(data);
                }
            });
        });
        
        req.on('error', reject);
        req.write(JSON.stringify(body));
        req.end();
    });
}

async function main() {
    console.log('Fetching exams...');
    const exams = await fetchJson(`${BASE_URL}/exams`);
    console.log(`Found ${exams.length} exams`);
    
    console.log('Fetching groups...');
    const groups = await fetchJson(`${BASE_URL}/groups`);
    console.log(`Found ${groups.length} groups`);
    
    console.log('\nExams:');
    exams.forEach(e => {
        console.log(`  - ${e.title} (grade_id: ${e.grade_id})`);
    });
    
    console.log('\nGroups:');
    groups.forEach(g => {
        console.log(`  - ${g.name} (grade_id: ${g.grade_id})`);
    });
    
    // Match exams to groups by grade_id
    console.log('\n\nMatching exams to groups:');
    for (const exam of exams) {
        const matchingGroups = groups.filter(g => 
            exam.grade_id === g.grade_id || exam.grade_id === null
        );
        
        console.log(`\nExam "${exam.title}":`);
        matchingGroups.forEach(g => {
            console.log(`  -> Group "${g.name}"`);
        });
    }
}

main().catch(console.error);
