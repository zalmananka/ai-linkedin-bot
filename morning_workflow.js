import 'dotenv/config';
import Parser from 'rss-parser';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';

const parser = new Parser({
  customFields: { item: ['media:content', 'content:encoded'] }
});

async function runMorningWorkflow() {
  console.log("=== STARTING MORNING NEWS WORKFLOW ===");

  try {
    // ==========================================
    // STEP 1: CONTENT SELECTION & OG IMAGE SCRAPER
    // ==========================================
    console.log("1. Fetching AI News from sources...");
    const sources = JSON.parse(await fs.readFile('./data/sources.json', 'utf-8'));
    const feedUrl = sources.Morning_AI[0];
    const feed = await parser.parseURL(feedUrl);

    let selectedArticle = null;

    for (const item of feed.items) {
      let imageUrl = null;

      // Check 1: Standard RSS XML tags
      imageUrl = (item['media:content'] && item['media:content']['$']?.url) ||
        (item.enclosure && item.enclosure.url) || null;

      // Check 2: HTML body within RSS
      if (!imageUrl && item['content:encoded']) {
        const imgMatch = item['content:encoded'].match(/<img[^>]+src="([^">]+)"/i);
        if (imgMatch) imageUrl = imgMatch[1];
      }

      // Check 3: The Python Trick! Fetch actual article URL and scrape Open Graph (og:image)
      if (!imageUrl && item.link) {
        try {
          console.log(`   -> RSS image missing. Scraping OG tags from: ${item.link}`);
          const articleHtml = await fetch(item.link).then(res => res.text());

          // Match <meta property="og:image" content="..."> or <meta name="twitter:image" content="...">
          const ogMatch = articleHtml.match(/<meta[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["']/i) ||
            articleHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["']/i) ||
            articleHtml.match(/<meta[^>]*name=["']twitter:image["'][^>]*content=["']([^"']+)["']/i);

          if (ogMatch) imageUrl = ogMatch[1];
        } catch (e) {
          console.log(`   -> Failed to scrape OG image: ${e.message}`);
        }
      }

      if (imageUrl) {
        selectedArticle = {
          title: item.title,
          content: item.contentSnippet || item.content,
          image: imageUrl,
          link: item.link
        };
        break; // Stop loop once we find a valid article with an image
      }
    }

    // Safety Fallback (Just in case the internet is completely broken)
    if (!selectedArticle && feed.items.length > 0) {
      console.log("⚠️ No explicit image found anywhere. Using a fallback Tech background.");
      const item = feed.items[0];
      selectedArticle = {
        title: item.title,
        content: item.contentSnippet || item.content,
        image: "https://images.unsplash.com/photo-1620712943543-bcc4688e7485?auto=format&fit=crop&w=1080&q=80",
        link: item.link
      };
    }

    if (!selectedArticle) {
      console.error("❌ Feed is completely empty. Aborting.");
      return;
    }

    console.log(`-> Selected Article: ${selectedArticle.title}`);
    console.log(`-> Image URL: ${selectedArticle.image}`);

    // ==========================================
    // STEP 2: LOAD BLUEPRINT & SCHEMA
    // ==========================================
    console.log("2. Loading News Blueprint & Schema...");
    const rawPrompt = await fs.readFile('./prompts/news.prompt', 'utf-8');
    const blueprint = await fs.readFile('./content/blueprints/news.json', 'utf-8');
    const schema = await fs.readFile('./content/schemas/news.schema.json', 'utf-8');

    const finalPrompt = rawPrompt
      .replace('{{BLUEPRINT}}', blueprint)
      .replace('{{SCHEMA}}', schema);

    // ==========================================
    // STEP 3: GROQ AI (Editor -> Creator)
    // ==========================================
    console.log("3. Generating JSON via Groq API...");
    const aiResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: "openai/gpt-oss-120b",
        messages: [
          { role: "system", content: finalPrompt },
          { role: "user", content: `Article Title: ${selectedArticle.title}\nContent: ${selectedArticle.content}` }
        ],
        response_format: { type: "json_object" }
      })
    });

    const aiData = await aiResponse.json();

    if (!aiData.choices) {
      console.error("❌ Groq API Error:", JSON.stringify(aiData, null, 2));
      return;
    }

    let jsonString = aiData.choices[0].message.content.trim();
    if (jsonString.startsWith('```json')) jsonString = jsonString.replace(/```json\n?/, '').replace(/```$/, '');
    console.log("-> RAW LLM JSON OUTPUT:\n", jsonString);
    let generatedData;
    try {
      generatedData = JSON.parse(jsonString);
    } catch (e) {
      console.error("❌ Failed to parse JSON from Groq. Raw output:", jsonString);
      return;
    }

    // JSON Structure Fallback (Fixes the "Cannot read properties of undefined (reading 'badge')" error)
    // If Groq forgot to nest data inside "visual_data", we fallback to the root object.
    const visual = generatedData.visual_data || generatedData;

    // ==========================================
    // STEP 4: PUPPETEER (Visual Rendering)
    // ==========================================
    // ==========================================
    // STEP 4: PUPPETEER (Visual Rendering)
    // ==========================================
    console.log("4. Rendering Visual Template (news.html)...");

    // 💡 NEW: Deep Search Helper Function
    // Yeh function Groq ke JSON mein deeply search karega, chahe usne format jaisa bhi banaya ho.
    function findKey(obj, targetKey) {
      if (typeof obj !== 'object' || obj === null) return null;
      if (obj.hasOwnProperty(targetKey)) return obj[targetKey];
      for (let key in obj) {
        let result = findKey(obj[key], targetKey);
        if (result) return result;
      }
      return null;
    }

    // Extracting data robustly
    const headlineText = findKey(generatedData, 'headline') || selectedArticle.title; const summaryText = findKey(generatedData, 'what_happened') || findKey(generatedData, 'summary') || 'Important developments in the AI space.';
    const whyItMattersText = findKey(generatedData, 'why_it_matters') || 'Read the full article to understand the impact on developers and founders.';
    const badgeText = findKey(generatedData, 'badge') || 'AI NEWS';

    console.log("   -> Extracted Headline:", headlineText); // Debugging ke liye terminal mein print karega

    let html = await fs.readFile('./templates/news.html', 'utf-8');

    html = html.replace('{{BADGE}}', badgeText)
      .replace('{{HEADLINE}}', headlineText)
      .replace('{{REAL_IMAGE_URL}}', selectedArticle.image)
      .replace('{{SUMMARY}}', summaryText)
      .replace('{{WHY_IT_MATTERS}}', whyItMattersText);

    const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1080 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: 'news_post.png' });
    await browser.close();
    console.log("   -> 'news_post.png' saved!");
    // ==========================================
    // STEP 5: PUBLISH TO LINKEDIN (Official API)
    // ==========================================
    console.log("5. Publishing to LinkedIn...");

    // (LinkedIn publishing code remains exactly the same as before)
    // I am omitting it here for brevity, keep the exact LinkedIn code you had from the previous step!

    console.log("✅ Workflow executed successfully.");

  } catch (error) {
    console.error("Pipeline Error:", error);
  }
}

runMorningWorkflow();