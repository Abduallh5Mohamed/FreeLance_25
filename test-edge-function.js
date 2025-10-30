// Direct test of the Supabase Edge Function
// This simulates exactly what StudentChat.tsx does

const SUPABASE_URL = 'https://xvzsuqihfbzrquhbpuhp.supabase.co';
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inh2enN1cWloZmJ6cnF1aGJwdWhwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MDk0MDcwODksImV4cCI6MTk5OTk5OTk5OX0.gKfz3PlJFM7iWCyH4sKHYXCHPvgB8DT-MIECPIhvCQk';

async function testEdgeFunction() {
  console.log('🧪 Testing Supabase Edge Function (ai-chat-assistant)\n');
  console.log('=' .repeat(60));
  
  // Simulate StudentChat.tsx behavior
  const message = 'شرح لي عن الثورة الفرنسية بإختصار';
  const studentId = 'test-student-001';
  
  console.log('\n📤 Request Details:');
  console.log(`  Message: "${message}"`);
  console.log(`  Student ID: ${studentId}`);
  console.log(`  Endpoint: ${SUPABASE_URL}/functions/v1/ai-chat-assistant\n`);
  
  try {
    console.log('⏳ Sending request...\n');
    
    const response = await fetch(
      `${SUPABASE_URL}/functions/v1/ai-chat-assistant`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ANON_KEY}`,
        },
        body: JSON.stringify({
          message: message,
          studentId: studentId,
        }),
      }
    );

    console.log(`📊 Response Status: ${response.status}\n`);

    const data = await response.json();

    if (!response.ok) {
      console.log('❌ Error Response:');
      console.log(JSON.stringify(data, null, 2));
      return false;
    }

    if (data.success) {
      console.log('✅ SUCCESS! Received AI Response:\n');
      console.log('=' .repeat(60));
      console.log(data.response);
      console.log('=' .repeat(60));
      return true;
    } else {
      console.log('❌ API returned error:');
      console.log(data.error);
      return false;
    }

  } catch (error) {
    console.error('❌ Network/Fetch Error:', error.message);
    return false;
  }
}

// Run the test
(async () => {
  const success = await testEdgeFunction();
  
  console.log('\n' + '=' .repeat(60));
  if (success) {
    console.log('✅ Edge Function Test: PASSED');
    console.log('\n📝 The StudentChat AI should now work perfectly!');
    console.log('   Go to http://localhost:8081/student-chat');
    console.log('   Click AI button and ask a question in Arabic');
  } else {
    console.log('❌ Edge Function Test: FAILED');
  }
  console.log('=' .repeat(60));
})();
