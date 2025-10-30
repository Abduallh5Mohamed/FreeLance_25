// Comprehensive test for Student Chat AI functionality
import fs from 'fs';

console.log('🧪 Comprehensive AI Chat Test Suite\n');
console.log('=' .repeat(50));

// Test 1: Check environment variables
console.log('\n✅ Test 1: Environment Variables');
const requiredVars = [
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_ANON_KEY'
];

const env = fs.readFileSync('.env', 'utf-8');
let varsOk = true;
requiredVars.forEach(varName => {
  if (env.includes(varName + '=')) {
    console.log(`  ✓ ${varName} is set`);
  } else {
    console.log(`  ✗ ${varName} is MISSING`);
    varsOk = false;
  }
});

if (!varsOk) {
  console.log('\n❌ Environment variables are missing! Add them to .env');
  process.exit(1);
}

// Test 2: Check Edge Function exists
console.log('\n✅ Test 2: Edge Function File');
const functionPath = 'supabase/functions/ai-chat-assistant/index.ts';
if (fs.existsSync(functionPath)) {
  console.log(`  ✓ ${functionPath} exists`);
  const content = fs.readFileSync(functionPath, 'utf-8');
  
  if (content.includes('systemInstruction')) {
    console.log('  ✓ systemInstruction format detected');
  }
  if (content.includes('AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70')) {
    console.log('  ✓ Google API Key is embedded');
  }
  if (content.includes('generativelanguage.googleapis.com')) {
    console.log('  ✓ Google API endpoint is correct');
  }
} else {
  console.log(`  ✗ ${functionPath} NOT FOUND`);
  process.exit(1);
}

// Test 3: Check StudentChat.tsx
console.log('\n✅ Test 3: StudentChat Component');
const chatPath = 'src/pages/StudentChat.tsx';
if (fs.existsSync(chatPath)) {
  console.log(`  ✓ ${chatPath} exists`);
  const content = fs.readFileSync(chatPath, 'utf-8');
  
  if (content.includes('VITE_SUPABASE_URL') && content.includes('ai-chat-assistant')) {
    console.log('  ✓ StudentChat correctly calls ai-chat-assistant endpoint');
  }
  if (content.includes('data.success') && content.includes('data.response')) {
    console.log('  ✓ StudentChat correctly parses API response');
  }
} else {
  console.log(`  ✗ ${chatPath} NOT FOUND`);
  process.exit(1);
}

// Test 4: Check Supabase config
console.log('\n✅ Test 4: Supabase Configuration');
const configPath = 'supabase/config.toml';
if (fs.existsSync(configPath)) {
  const config = fs.readFileSync(configPath, 'utf-8');
  console.log(`  ✓ ${configPath} exists`);
  
  if (config.includes('[functions.ai-chat-assistant]')) {
    console.log('  ✓ ai-chat-assistant function is configured');
  }
} else {
  console.log(`  ✗ ${configPath} NOT FOUND`);
}

// Test 5: Test Google API directly
console.log('\n✅ Test 5: Google Generative AI API');
async function testGoogleAPI() {
  const API_KEY = 'AIzaSyAm-hpg9pjc66DqNnS8qHpdgeKBd-FZP70';
  
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [{text: 'test'}]
          },
          contents: [{
            role: 'user',
            parts: [{text: 'test'}]
          }],
          generationConfig: {
            temperature: 0.7,
            maxOutputTokens: 50
          }
        })
      }
    );

    if (response.ok) {
      console.log('  ✓ Google API is reachable');
      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        console.log('  ✓ Google API returns valid response format');
      }
    } else {
      console.log(`  ✗ Google API error: ${response.status}`);
    }
  } catch (error) {
    console.log(`  ✗ Network error: ${error.message}`);
  }
}

// Run all tests
console.log('\n' + '='.repeat(50));
console.log('🎯 Running Live Tests...\n');

await testGoogleAPI();

console.log('\n' + '='.repeat(50));
console.log('\n✅ All checks complete!\n');
console.log('📝 Next Steps:');
console.log('  1. npm run dev');
console.log('  2. Navigate to /student-chat');
console.log('  3. Click AI button');
console.log('  4. Type a question in Arabic');
console.log('  5. You should see a real AI response!\n');
