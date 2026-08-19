import 'dotenv/config';
import Parser from 'rss-parser';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';

const parser = new Parser();

async function runPipeline() {
  try {
    // ==========================================
    // STEP 1: CONTENT SEARCH (AI & CS News)
    // ==========================================
    console.log("1. Fetching AI & Computer Science News...");
    const feed = await parser.parseURL('https://techcrunch.com/category/artificial-intelligence/feed/');
    const topNews = feed.items.slice(0, 4).map(item => `${item.title}: ${item.contentSnippet}`).join('\n\n');

    // ==========================================
    // STEP 2: CONTENT WRITING (OpenRouter AI)
    // ==========================================
    console.log("2. Generating Content via AI...");
    const aiResponse = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`, 
        'Content-Type': 'application/json' 
      },
      body: JSON.stringify({
        model: "anthropic/claude-3-5-sonnet", // Or your preferred model
        messages: [{ 
          role: "user", 
          content: `You are a Computer Science and AI expert. Based on this news:\n${topNews}\n
          Write a highly engaging LinkedIn post. Return ONLY a valid JSON object (no markdown, no extra text) with these keys: 
          "post_text" (the LinkedIn post content), 
          "title_main" (short title), 
          "title_span" (highlighted word), 
          "subtitle" (brief context), 
          "badge" (e.g., 🚀 AI TRENDS), 
          "takeaway_num" (a stat or number), 
          "takeaway_text" (short conclusion), 
          "bars" (an array of exactly 4 objects, each with "label", "value" as a percentage string, and "color" as a hex code like #5E6AD2).`
        }]
      })
    });
    
    const aiData = await aiResponse.json();
    
    // Clean up potential markdown from the LLM response
    let jsonString = aiData.choices[0].message.content.trim();
    if (jsonString.startsWith('```json')) jsonString = jsonString.replace(/```json\n?/, '').replace(/```$/, '');
    
    const data = JSON.parse(jsonString);

    // ==========================================
    // STEP 3: CONTENT POST DESIGNER (Puppeteer)
    // ==========================================
    console.log("3. Rendering Infographic PNG...");
    let html = await fs.readFile('template.html', 'utf-8');
    
    let barsHtml = data.bars.map(b => `
      <div class="bar-row">
        <div class="bar-info"><span>${b.label}</span><span>${b.value}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width: ${b.value}; background: ${b.color};"></div></div>
      </div>`).join('');
    
    html = html.replace('{{BADGE}}', data.badge)
               .replace('{{TITLE_MAIN}}', data.title_main)
               .replace('{{TITLE_SPAN}}', data.title_span)
               .replace('{{SUBTITLE}}', data.subtitle)
               .replace('{{BAR_ROWS}}', barsHtml)
               .replace('{{TAKEAWAY_NUM}}', data.takeaway_num)
               .replace('{{TAKEAWAY_TEXT}}', data.takeaway_text);
    
    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'infographic.png' });
    await browser.close();
    console.log("   -> infographic.png saved!");

    // ==========================================
    // STEP 4: PUBLISH TO LINKEDIN (Official API)
    // ==========================================
    console.log("4. Publishing to LinkedIn...");
    const token = process.env.LINKEDIN_ACCESS_TOKEN;
    const authorUrn = process.env.LINKEDIN_PERSON_URN;
    const authHeader = { 'Authorization': `Bearer ${token}`, 'X-Restli-Protocol-Version': '2.0.0' };

    // 4a. Register Upload
    const registerReq = await fetch('https://api.linkedin.com/v2/assets?action=registerUpload', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        registerUploadRequest: {
          recipes: ['urn:li:digitalmediaRecipe:feedshare-image'],
          owner: authorUrn,
          serviceRelationships: [{ relationshipType: 'OWNER', identifier: 'urn:li:userGeneratedContent' }]
        }
      })
    });
    const registerData = await registerReq.json();
    const uploadUrl = registerData.value.uploadMechanism['com.linkedin.digitalmedia.uploading.MediaUploadHttpRequest'].uploadUrl;
    const assetUrn = registerData.value.asset;

    // 4b. Upload the PNG binary
    const imageBuffer = await fs.readFile('infographic.png');
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` }, // specific headers for media upload
      body: imageBuffer
    });

    // 4c. Create the Post
    const postReq = await fetch('https://api.linkedin.com/v2/ugcPosts', {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: 'PUBLISHED',
        specificContent: {
          'com.linkedin.ugc.ShareContent': {
            shareCommentary: { text: data.post_text },
            shareMediaCategory: 'IMAGE',
            media: [{ status: 'READY', media: assetUrn }]
          }
        },
        visibility: { 'com.linkedin.ugc.MemberNetworkVisibility': 'PUBLIC' }
      })
    });

    if (postReq.ok) {
      console.log("✅ Success! Post published to LinkedIn.");
    } else {
      const error = await postReq.text();
      console.error("❌ Failed to publish post:", error);
    }

  } catch (error) {
    console.error("Pipeline Error:", error);
  }
}

runPipeline();
