import 'dotenv/config';
import Parser from 'rss-parser';
import puppeteer from 'puppeteer';
import fs from 'fs/promises';

const parser = new Parser();

// Helper function to map exact angle names to our file names
function getFilePrefix(angleName) {
    if (angleName.includes('Comparison')) return 'comparison';
    if (angleName.includes('Pro Tip')) return 'pro-tip';
    if (angleName.includes('Incident')) return 'incident';
    if (angleName.includes('Case Study')) return 'case-study';
    return 'news';
}

async function runEveningWorkflow() {
    console.log("=== STARTING EVENING MATRIX WORKFLOW ===");

    try {
        // ==========================================
        // STEP 1: MATRIX STATE ENGINE
        // ==========================================
        console.log("1. Reading State Matrix...");
        let state = JSON.parse(await fs.readFile('./data/state.json', 'utf-8'));

        let topicIndex = state.matrix_state.topic_index;
        let angleIndex = state.matrix_state.angle_index;

        const currentTopic = state.topics[topicIndex];
        const currentAngle = state.angles[angleIndex];

        console.log(`-> Today's Target: [${currentTopic}] + [${currentAngle}]`);

        // ==========================================
        // STEP 2: RSS AGGREGATOR & FALLBACK LOGIC
        // ==========================================
        console.log("2. Fetching Candidate Sources...");
        const sources = JSON.parse(await fs.readFile('./data/sources.json', 'utf-8'));
        const feedUrls = sources[currentTopic] || [];
        
        let allArticles = [];
        for (const url of feedUrls) {
            try {
                const feed = await parser.parseURL(url);
                const articles = feed.items.slice(0, 5).map(i => `Title: ${i.title}\nSnippet: ${i.contentSnippet || i.content}`);
                allArticles = allArticles.concat(articles);
            } catch (err) {
                console.log(`   [Warning] Failed to fetch feed: ${url}`);
            }
        }

        let userPromptContext = "";

        // 💡 THE FALLBACK LOGIC
        if (allArticles.length === 0) {
            console.log("⚠️ No articles found in RSS. Activating Fallback Pool...");
            const fallbackData = JSON.parse(await fs.readFile('./data/fallback_pool.json', 'utf-8'));
            const topicFallbacks = fallbackData[currentTopic] || [];
            
            // Try to find a fallback idea that matches today's angle
            const validFallbacks = topicFallbacks.filter(f => f.angles.includes(currentAngle));
            const selectedFallback = validFallbacks.length > 0 ? validFallbacks[0] : (topicFallbacks[0] || null);

            if (!selectedFallback) {
                console.error("❌ No fallback idea found for this topic. Aborting.");
                return;
            }

            console.log(`   -> Using Fallback Idea: ${selectedFallback.idea}`);
            userPromptContext = `We don't have latest news today. Instead, write a highly engaging educational post about this specific topic idea:\n"${selectedFallback.idea}"\n\nEnsure it perfectly matches the requested angle and JSON schema.`;
        } else {
            const combinedNews = allArticles.slice(0, 8).join('\n\n---\n\n');
            userPromptContext = `Here are the latest candidate articles for ${currentTopic}:\n\n${combinedNews}\n\nSelect the best one and generate the JSON.`;
        }

        // ==========================================
        // STEP 3: ASSEMBLE CONTENT BLUEPRINT & PROMPT
        // ==========================================
        console.log("3. Loading Content Blueprint & Schema...");
        const filePrefix = getFilePrefix(currentAngle);
        
        const rawPrompt = await fs.readFile(`./prompts/${filePrefix}.prompt`, 'utf-8');
        const blueprint = await fs.readFile(`./content/blueprints/${filePrefix}.json`, 'utf-8');
        const schema = await fs.readFile(`./content/schemas/${filePrefix}.schema.json`, 'utf-8');

        const finalPrompt = rawPrompt
            .replace('{{BLUEPRINT}}', blueprint)
            .replace('{{SCHEMA}}', schema);

        // ==========================================
        // STEP 4: GROQ EDITOR & CREATOR
        // ==========================================
        console.log("4. Generating Structured Content via Groq...");
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
                    { role: "user", content: userPromptContext } // 💡 Injecting either RSS News OR Fallback Idea here
                ],
                response_format: { type: "json_object" }
            })
        });

        const aiData = await aiResponse.json();

        // API error handling
        if (!aiData.choices) {
            console.error("❌ Groq API Error:", JSON.stringify(aiData, null, 2));
            return;
        }

        let jsonString = aiData.choices[0].message.content.trim();
        if (jsonString.startsWith('```json')) jsonString = jsonString.replace(/```json\n?/, '').replace(/```$/, '');
        const generatedData = JSON.parse(jsonString);

        // ==========================================
        // STEP 5: PUPPETEER RENDERER
        // ==========================================
        console.log(`5. Rendering Visual Template (${filePrefix}.html)...`);
        let html = await fs.readFile(`./templates/${filePrefix}.html`, 'utf-8');

        // Dynamically replace all keys from visual_data
        const visualData = generatedData.visual_data;
        for (const [key, value] of Object.entries(visualData)) {
            if (typeof value === 'string') {
                const regex = new RegExp(`{{${key.toUpperCase()}}}`, 'g');
                html = html.replace(regex, value);
            }
        }

        // Special handling for array fields (like steps, lists, timeline)
        if (visualData.steps) {
            html = html.replace('{{STEP_1}}', visualData.steps[0] || '')
                .replace('{{STEP_2}}', visualData.steps[1] || '')
                .replace('{{STEP_3}}', visualData.steps[2] || '');
        }
        if (visualData.subject_a && visualData.subject_a.strengths) {
            html = html.replace('{{TOOL_A_NAME}}', visualData.subject_a.name)
                .replace('{{TOOL_A_STRENGTH_1}}', visualData.subject_a.strengths[0] || '')
                .replace('{{TOOL_A_STRENGTH_2}}', visualData.subject_a.strengths[1] || '');
        }
        if (visualData.subject_b && visualData.subject_b.strengths) {
            html = html.replace('{{TOOL_B_NAME}}', visualData.subject_b.name)
                .replace('{{TOOL_B_STRENGTH_1}}', visualData.subject_b.strengths[0] || '')
                .replace('{{TOOL_B_STRENGTH_2}}', visualData.subject_b.strengths[1] || '');
        }
        if (visualData.timeline) {
            html = html.replace('{{ATTACK_VECTOR}}', visualData.timeline[0] || '')
                .replace('{{ROOT_CAUSE}}', visualData.timeline[1] || '')
                .replace('{{IMPACT}}', visualData.timeline[2] || '');
        }
        if (visualData.lessons) {
            html = html.replace('{{LESSON_1}}', visualData.lessons[0] || '');
        }

        const browser = await puppeteer.launch({ args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setViewport({ width: 1080, height: 1080 });
        await page.setContent(html, { waitUntil: 'networkidle0' });
        await page.evaluate(() => document.fonts.ready);
        await page.screenshot({ path: `evening_post_${filePrefix}.png` });
        await browser.close();

        console.log("   -> Screenshot saved successfully!");

        // Save caption
        await fs.writeFile('evening_caption.txt', generatedData.linkedin_caption);

        // ==========================================
        // STEP 6: UPDATE STATE MATRIX
        // ==========================================
        console.log("6. Updating Matrix State for tomorrow...");
        // Move to next topic
        topicIndex++;
        if (topicIndex >= state.topics.length) {
            topicIndex = 0; // Reset topic
            angleIndex++;   // Move to next angle
            if (angleIndex >= state.angles.length) {
                angleIndex = 0; // Full 16-day cycle completed, reset!
            }
        }

        state.matrix_state.topic_index = topicIndex;
        state.matrix_state.angle_index = angleIndex;
        state.last_run_date = new Date().toISOString().split('T')[0];

        await fs.writeFile('./data/state.json', JSON.stringify(state, null, 2));

        console.log("=== EVENING WORKFLOW COMPLETE! ===");

    } catch (error) {
        console.error("Workflow failed:", error);
    }
}

runEveningWorkflow();