// Test script to verify Google Generative AI API works
const API_KEY = process.env.GOOGLE_GEMINI_API_KEY;
if (!API_KEY) throw new Error('Set GOOGLE_GEMINI_API_KEY in the environment.');

async function testAI() {
  try {
    console.log('🚀 Testing Google Generative AI API...\n');

    const payload = {
      systemInstruction: {
        parts: [{
          text: 'أنت مساعد تاريخ متخصص'
        }]
      },
      contents: [{
        role: 'user',
        parts: [{
          text: 'اشرح لي الثورة الفرنسية بإختصار'
        }]
      }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 500
      }
    };

    console.log('📤 Sending request...');
    console.log('Payload:', JSON.stringify(payload, null, 2), '\n');

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${API_KEY}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error('❌ API Error:', response.status);
      console.error('Response:', JSON.stringify(data, null, 2));
      return false;
    }

    console.log('✅ API Response Successful!\n');

    if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
      const aiResponse = data.candidates[0].content.parts[0].text;
      console.log('🤖 AI Response:');
      console.log(aiResponse);
      return true;
    } else {
      console.error('❌ Invalid response format');
      console.error('Data:', JSON.stringify(data, null, 2));
      return false;
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
    return false;
  }
}

testAI().then(success => {
  if (success) {
    console.log('\n✅ AI API is working correctly!');
    process.exit(0);
  } else {
    console.log('\n❌ AI API test failed!');
    process.exit(1);
  }
});
