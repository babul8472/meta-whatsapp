const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, 'index_debug.log');
// Clear the log file on launch
try { fs.writeFileSync(logFile, '', 'utf8'); } catch (e) {}

const originalLog = console.log;
console.log = function(...args) {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '\n';
    try { fs.appendFileSync(logFile, msg, 'utf8'); } catch (e) {}
};
const originalError = console.error;
console.error = function(...args) {
    originalError.apply(console, args);
    const msg = '[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '\n';
    try { fs.appendFileSync(logFile, msg, 'utf8'); } catch (e) {}
};

console.log('Script started. Initializing client in HEADLESS mode...');

const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const https = require('https');
const { execSync, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Define Input Parameters
const topic = "Space exploration and human colonizing of Mars";
const duration = "60 seconds";
const language = "English"; // Can be English, Hindi, Urdu, Bengali, Spanish, etc.
const voiceover = "Female"; // Male or Female
const aspect_ratio = "16:9"; // "16:9", "9:16", or "1:1"

// Setup output directory
const outputDirName = `output_${Date.now()}`;
const outputDir = path.join(__dirname, outputDirName);
if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
}
console.log(`Assets will be saved to: ${outputDir}`);

let client; // Instantiated dynamically at bottom

function registerClientEvents(clientInstance) {
    clientInstance.on('qr', (qr) => {
        console.log('\n--- SCAN THIS QR CODE WITH YOUR PHONE ---');
        qrcode.generate(qr, { small: true });
        console.log('-----------------------------------------\n');
        currentQrText = qr;
        statusText = "Scan QR code to connect WhatsApp";
    });

    clientInstance.on('ready', async () => {
        console.log('WhatsApp Web Client is ready (HEADLESS Mode)!');
        isClientReady = true;
        currentQrText = null;
        statusText = "Ready to start pipeline";
        
        const page = clientInstance.pupPage;
        if (page) {
            // Set up live monitor screenshot interval saving to workspace
            setInterval(async () => {
                try {
                    await page.screenshot({ path: path.join(__dirname, 'live_status.png') });
                } catch (e) {}
            }, 3000);
        }
    });

    clientInstance.on('disconnected', async (reason) => {
        console.log('WhatsApp Client was disconnected:', reason);
        isClientReady = false;
        currentQrText = null;
        statusText = "Disconnected. Re-initializing WhatsApp Web...";
        
        try {
            await clientInstance.destroy();
        } catch(e) {}
        
        setTimeout(() => {
            bootClient();
        }, 3000);
    });
}

// Helper function to extract text from rich_response payload
function getMessageText(message) {
    if (message.type === 'rich_response' && message._data && message._data.richResponse) {
        const fragments = message._data.richResponse.fragments;
        if (fragments && fragments.length > 0) {
            return fragments.map(f => f.text).join('\n');
        }
    }
    return message.body;
}

// Redirection-aware downloader helper
function downloadUrl(url, destPath) {
    return new Promise((resolve, reject) => {
        function get(targetUrl) {
            https.get(targetUrl, (response) => {
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    get(response.headers.location);
                    return;
                }
                if (response.statusCode !== 200) {
                    reject(new Error(`Failed to download: Status ${response.statusCode}`));
                    return;
                }
                const file = fs.createWriteStream(destPath);
                response.pipe(file);
                file.on('finish', () => {
                    file.close();
                    resolve();
                });
                file.on('error', (err) => {
                    fs.unlink(destPath, () => reject(err));
                });
            }).on('error', reject);
        }
        get(url);
    });
}

// Edge TTS Voice lookup mapping table
function getVoiceCode(lang, gender) {
    const l = lang.toLowerCase();
    const isMale = gender.toLowerCase().includes('male') && !gender.toLowerCase().includes('female');
    
    if (l.includes('hindi')) {
        return isMale ? 'hi-IN-MadhurNeural' : 'hi-IN-SwaraNeural';
    } else if (l.includes('spanish')) {
        return isMale ? 'es-ES-AlvaroNeural' : 'es-ES-ElviraNeural';
    } else if (l.includes('urdu')) {
        return isMale ? 'ur-PK-AsadNeural' : 'ur-PK-UzmaNeural';
    } else if (l.includes('bengali') || l.includes('bangla')) {
        return isMale ? 'bn-IN-BashkarNeural' : 'bn-IN-TanishaaNeural';
    } else if (l.includes('french')) {
        return isMale ? 'fr-FR-HenriNeural' : 'fr-FR-DeniseNeural';
    } else if (l.includes('german')) {
        return isMale ? 'de-DE-ConradNeural' : 'de-DE-KatjaNeural';
    } else {
        // Default to English
        return isMale ? 'en-US-GuyNeural' : 'en-US-AriaNeural';
    }
}

// Construct FFmpeg zoompan filter based on effect and direction
function getZoompanFilter(imageSize, position, totalFrames, width, height) {
    const defaultZoom = '1';
    const defaultX = 'iw/2-(iw/zoom/2)';
    const defaultY = 'ih/2-(ih/zoom/2)';
    
    let z = defaultZoom;
    let x = defaultX;
    let y = defaultY;
    
    const size = (imageSize || '').toLowerCase();
    const pos = (position || '').toLowerCase();
    
    const cx = 'iw/2-(iw/zoom/2)';
    const cy = 'ih/2-(ih/zoom/2)';
    
    if (size === 'pan') {
        z = '1.3';
        if (pos === 'top') {
            y = `(${cy})*(1-on/${totalFrames})`;
        } else if (pos === 'bottom') {
            y = `(${cy})*(1+on/${totalFrames})`;
        } else if (pos === 'left') {
            x = `(${cx})*(1-on/${totalFrames})`;
        } else if (pos === 'right') {
            x = `(${cx})*(1+on/${totalFrames})`;
        }
    } else if (size === 'zoom') {
        z = `min(zoom+0.0015,1.5)`;
    } else if (size === 'zoomout') {
        z = `max(1.5-0.0015*on,1)`;
    } else if (size === 'panzoom') {
        z = `min(zoom+0.0015,1.5)`;
        if (pos === 'top') {
            y = `(${cy})*(1-on/${totalFrames})`;
        } else if (pos === 'bottom') {
            y = `(${cy})*(1+on/${totalFrames})`;
        } else if (pos === 'left') {
            x = `(${cx})*(1-on/${totalFrames})`;
        } else if (pos === 'right') {
            x = `(${cx})*(1+on/${totalFrames})`;
        }
    } else if (size === 'panzoomout') {
        z = `max(1.5-0.0015*on,1)`;
        if (pos === 'top') {
            y = `(${cy})*(on/${totalFrames})`;
        } else if (pos === 'bottom') {
            y = `(${cy})*(2-on/${totalFrames})`;
        } else if (pos === 'left') {
            x = `(${cx})*(on/${totalFrames})`;
        } else if (pos === 'right') {
            x = `(${cx})*(2-on/${totalFrames})`;
        }
    }
    
    // If no zoom/pan effect, return standard scale filter
    if (z === defaultZoom && x === defaultX && y === defaultY) {
        return `scale=${width}:${height}`;
    }
    
    return `scale=8000:-1,zoompan=z='${z}':x='${x}':y='${y}':d=${totalFrames}:s=${width}x${height}`;
}

// Edge TTS voice generation executor using temporary file to prevent Windows quote escaping issues with retry backoff
async function generateVoiceover(text, voice, destPath) {
    const tempFile = destPath + '.txt';
    fs.writeFileSync(tempFile, text, 'utf8');
    
    let success = false;
    let attempts = 3;
    
    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            console.log(`Generating Edge TTS voiceover using voice: ${voice} (Attempt #${attempt}/${attempts})...`);
            await execPromise(`edge-tts --file "${tempFile}" --write-media "${destPath}" --voice "${voice}"`);
            console.log(`SUCCESS: Saved audio file to: ${destPath}`);
            success = true;
            break;
        } catch (err) {
            console.error(`Attempt #${attempt} failed to generate Edge TTS voiceover:`, err.message || err);
            if (attempt < attempts) {
                const waitTime = attempt * 2000;
                console.log(`Waiting ${waitTime / 1000}s before retrying...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
            }
        }
    }
    
    try { fs.unlinkSync(tempFile); } catch (e) {}
    
    if (!success) {
        throw new Error(`Failed to generate Edge TTS voiceover after ${attempts} attempts.`);
    }
}

// Dismiss popup welcome modals
async function dismissModals(page) {
    console.log('Checking for blocking modals...');
    try {
        const closed = await page.evaluate(() => {
            const clickables = Array.from(document.querySelectorAll('button, div[role="button"], span[role="button"]'));
            const closeBtn = clickables.find(el => {
                const label = (el.getAttribute('aria-label') || '').toLowerCase();
                const testid = (el.getAttribute('data-testid') || '').toLowerCase();
                const text = el.textContent.trim().toLowerCase();
                if (label.includes('close') || testid.includes('close') || text === 'close' || text === 'x') return true;
                const svg = el.querySelector('svg');
                if (svg) {
                    const svgTestid = (svg.getAttribute('data-testid') || '').toLowerCase();
                    const svgTitle = (svg.querySelector('title')?.textContent || '').toLowerCase();
                    if (svgTestid.includes('close') || svgTestid.includes('x') || svgTitle.includes('close') || svgTestid.includes('x-alt')) return true;
                }
                return false;
            });
            if (closeBtn) {
                closeBtn.click();
                return true;
            }
            return false;
        });
        if (closed) {
            console.log('Dismissed welcome modal.');
            await new Promise(resolve => setTimeout(resolve, 2000));
        } else {
            console.log('No welcome modals found.');
        }
    } catch (err) {
        console.error('Error closing modals:', err);
    }
}

// Check if response text indicates block/failure from Meta AI
function isGenerationFailed(text) {
    const lower = text.toLowerCase();
    return lower.includes("can't generate") || 
           lower.includes("couldn't generate") || 
           lower.includes("blocked") || 
           lower.includes("refuse") || 
           lower.includes("policy") || 
           lower.includes("violation") || 
           lower.includes("unable") || 
           lower.includes("error");
}

// Helper to write text into the chat compose field at once (react-safe inner text inserter)
async function writeTextToInput(page, selector, text) {
    await page.evaluate((sel, txt) => {
        const el = document.querySelector(sel);
        if (el) {
            el.focus();
            // Clear current content
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            // Insert full multiline string as a single text block
            document.execCommand('insertText', false, txt);
        }
    }, selector, text);
}

// Poll helper that checks for a NEW message from Meta AI after a baseline message ID, validating its content via validatorFn
async function pollNewMessage(chat, lastMsgId, promptStartTime, validatorFn, maxTimeoutMs = 60000) {
    const startTime = Date.now();
    while (Date.now() - startTime < maxTimeoutMs) {
        await new Promise(resolve => setTimeout(resolve, 4000));
        try {
            const messages = await chat.fetchMessages({ limit: 20 });
            let newMessages = messages;
            if (lastMsgId) {
                const lastIdx = messages.findIndex(m => m.id.id === lastMsgId);
                if (lastIdx !== -1) {
                    newMessages = messages.slice(lastIdx + 1);
                } else {
                    newMessages = messages.filter(m => m.timestamp >= promptStartTime - 60);
                }
            } else {
                newMessages = messages.filter(m => m.timestamp >= promptStartTime - 60);
            }
            
            // Look for the latest incoming message from Meta AI in the new messages
            const replyMsg = newMessages.slice().reverse().find(m => !m.fromMe);
            if (replyMsg) {
                const text = getMessageText(replyMsg);
                if (validatorFn(replyMsg, text)) {
                    return replyMsg;
                }
            }
        } catch (e) {
            console.error('Error in pollNewMessage:', e);
        }
    }
    return null;
}

let isClientReady = false;
let isGenerating = false;
let statusText = "Client starting...";
let lastFolder = "";
let currentQrText = null;



// Run generation pipeline on demand
async function runGenerationPipeline({ topic, duration, language, voiceover, aspect_ratio }) {
    isGenerating = true;
    statusText = "Starting pipeline...";
    
    // Clear the debug log for a fresh start on each UI trigger
    try { fs.writeFileSync(logFile, '', 'utf8'); } catch (e) {}
    console.log('--- NEW PIPELINE RUN ---');
    console.log(`Topic: "${topic}"`);
    console.log(`Duration: "${duration}"`);
    console.log(`Language: "${language}"`);
    console.log(`Voiceover: "${voiceover}"`);
    console.log(`Aspect Ratio: "${aspect_ratio}"`);
    console.log('------------------------\n');

    // Setup output directory
    const outputDirName = `output_${Date.now()}`;
    const outputDir = path.join(__dirname, outputDirName);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }
    lastFolder = outputDirName;
    console.log(`Assets will be saved to: ${outputDir}`);

    // Manage output folders (Keep only current and last, delete others)
    try {
        const items = fs.readdirSync(__dirname);
        const outputFolders = items
            .filter(item => {
                const itemPath = path.join(__dirname, item);
                return fs.statSync(itemPath).isDirectory() && /^output_\d+$/.test(item);
            })
            .map(item => {
                const ts = parseInt(item.split('_')[1], 10);
                return { name: item, path: path.join(__dirname, item), timestamp: ts };
            })
            .sort((a, b) => b.timestamp - a.timestamp); // descending (newest first)

        if (outputFolders.length > 2) {
            const foldersToDelete = outputFolders.slice(2);
            for (const folder of foldersToDelete) {
                console.log(`Cleanup: Automatically deleting old output folder: ${folder.name}`);
                fs.rmSync(folder.path, { recursive: true, force: true });
            }
        }
    } catch (e) {
        console.error('Error during output folder cleanup:', e);
    }

    let page = client.pupPage;
    try {
        if (!page || page.isClosed()) {
            console.log('Puppeteer page is missing or closed. Restoring active page from browser...');
            const pages = await client.pupBrowser.pages();
            page = pages.find(p => !p.isClosed()) || pages[0];
            if (page) {
                client.pupPage = page;
            }
        }
    } catch (e) {
        console.warn('Warning: Error checking page state:', e.message);
    }

    if (!page) {
        console.error('Puppeteer page not found.');
        isGenerating = false;
        statusText = "Error: Puppeteer page not found";
        return;
    }

    try {
        statusText = "Preparing browser window...";
        try {
            await page.setViewport({ width: 1280, height: 800 });
        } catch (e) {
            console.warn('Warning: Failed to set viewport, proceeding anyway:', e.message);
        }
        await new Promise(resolve => setTimeout(resolve, 7000));
        await dismissModals(page);
        await page.screenshot({ path: path.join(__dirname, 'after_modal_dismiss.png') });

        console.log('Locating Meta AI row in sidebar...');
        statusText = "Connecting to Meta AI...";
        const metaAiHandle = await page.evaluateHandle(() => {
            const spans = Array.from(document.querySelectorAll('span'));
            const span = spans.find(s => s.textContent.trim() === 'Meta AI' || s.getAttribute('title') === 'Meta AI');
            return span ? (span.closest('div[role="row"]') || span.closest('div[data-testid^="list-item-"]') || span) : null;
        });

        const metaAiElement = metaAiHandle.asElement();
        if (!metaAiElement) {
            console.error('Meta AI row not found in sidebar.');
            isGenerating = false;
            statusText = "Error: Meta AI row not found";
            return;
        }

        console.log('Clicking Meta AI row...');
        await metaAiElement.click();
        await new Promise(resolve => setTimeout(resolve, 4000));
        await page.screenshot({ path: path.join(__dirname, 'after_click.png') });

        const inputSelector = 'div[data-testid="conversation-compose-box-input"], div[contenteditable="true"][role="textbox"]';
        await page.waitForSelector(inputSelector, { timeout: 15000 });
        
        const durSeconds = parseInt(duration) || 60;
        const wordCount = durSeconds * 3;
        const totalScenes = Math.round(durSeconds / 3);
        const sceneDuration = 3.0;

        // Create script prompt based on input parameters and strict custom formatting rules
        const scriptPrompt = `Topic: "${topic}"
Duration: ${durSeconds} seconds
Language: ${language}
Voiceover Gender: ${voiceover}
Aspect Ratio: ${aspect_ratio}

You are an expert short-form video scriptwriter specializing in viral social media reels across all genres (comedy, drama, motivational, horror, educational, emotional, mythological, etc.).

CRITICAL RULE (applies to every single scene, no exceptions): Narration must ALWAYS be short — 6 to 10 words per scene, spoken in under 4 seconds. Never write long or descriptive sentences. Short, punchy, one-breath lines only. This rule overrides everything else — if a story beat needs more words, split it into two scenes instead of writing a longer line.

STEP 1 - ANALYZE TOPIC:
Identify genre/tone, number of characters needed (0 if narration-only/educational), and setting/time period implied by the topic.

STEP 2 - TITLE:
Refine the topic into a short, catchy, curiosity-driven title (max 8 words) fitting the identified genre.

STEP 3 - CHARACTER SETUP (skip only if topic has zero characters):
For each character define:
- Name (culturally appropriate to the topic/language)
- One-line personality trait or role
- Fixed visual appearance (clothing, build, distinguishing feature) — reuse this EXACT description in every image prompt where the character appears.

STEP 4 - SCRIPT:
Write a script of at least ${wordCount} words (~3 words per second of narration, scaled to ${durSeconds} seconds) in ${language}.
- Write narration entirely in the native script of ${language} (e.g. Devanagari for Hindi) — do NOT romanize/transliterate into English letters, and do NOT mix in English words unless there is no natural equivalent.
- Structure: Hook → Setup → Development → Peak moment → Closing line, matching genre.
- Every line must be short and conversational — like a quick spoken thought, not a written sentence. Example of correct length: "राहुल अचानक रुक गया।" Example of WRONG length (too long, never write like this): "राहुल जो हमेशा सबसे आगे रहता था, अचानक बीच रास्ते में रुक गया और सोचने लगा।"
- Avoid tongue-twisting or hard-to-pronounce word clusters — this will be read aloud by TTS.
- Write numbers, dates, and abbreviations in words, not digits.

STEP 5 - SCENE BREAKDOWN:
Split the script into exactly ${totalScenes} consecutive scenes (~${sceneDuration} seconds each).
- HARD LIMIT: 6 to 10 words per scene narration, always. No scene may exceed 10 words, under any circumstance.
- If a moment feels like it needs more words, break it into two shorter scenes instead — never stretch one scene's narration to cover it.
- Distribute the ${wordCount}-word script across ${totalScenes} scenes as evenly as timing allows — do not pad or shorten scenes just to hit a count.
- Carry forward the same character(s) with their EXACT fixed visual description, if applicable.
- Ensure clear visual progression — no two consecutive scenes should look visually identical (vary angle, action, expression, setting, or time of day).
- Match emotional tone/genre visually and narratively.
- Never cut a sentence awkwardly across two scenes — each scene's narration must be a complete, natural short phrase.

For each scene, output EXACTLY in this format (no extra text/headers, no explanations outside scene blocks):

Scene {number}
Narration: [narration text in ${language}, native script only, 6-10 words maximum]
Image Prompt: /imagine [English prompt — character(s) with fixed appearance if applicable, action/expression, setting, camera angle (close-up/wide/medium/POV), lighting mood matching genre, art style: cinematic realistic photo style, vertical 9:16 composition, no text or watermark in image]

Ensure exactly ${totalScenes} scenes, numbered 1 to ${totalScenes}, covering hook → setup → development → peak → closing, regardless of topic or genre.

FINAL CHECK before output (mandatory — recount every scene): Go through all ${totalScenes} scenes one by one and count the words in each narration. If any scene has more than 10 words, rewrite it shorter before giving the final output. Confirm all narration is in ${language} native script, character descriptions are consistent, and there are exactly ${totalScenes} scenes.`;
        
        console.log(`Writing unified script generation prompt to text field (expecting exactly ${totalScenes} scenes)...`);
        statusText = `Generating ${totalScenes}-scene script...`;
        
        // Find the baseline chat and message ID before sending
        const chats = await client.getChats();
        const chat = chats.find(c => c.id._serialized === '13135550002@c.us');
        if (!chat) {
            console.error('Meta AI chat not found.');
            isGenerating = false;
            statusText = "Error: Meta AI chat not found";
            return;
        }
        
        const initialMessages = await chat.fetchMessages({ limit: 5 });
        const lastMsgIdBeforeScript = initialMessages.length > 0 ? initialMessages[initialMessages.length - 1].id.id : null;
        const promptStartTime = Math.floor(Date.now() / 1000);
        
        await writeTextToInput(page, inputSelector, scriptPrompt);
        
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('Pressing Enter key to send prompt as a single message...');
        await page.keyboard.press('Enter');

        console.log(`Message sent! Polling for completed ${totalScenes}-scene script reply from Meta AI...`);
        
        let scriptText = '';
        let scriptSuccess = false;
        
        // Script validator function to check for the final scene start
        const scriptValidator = (msg, text) => {
            if (!text) return false;
            if (isGenerationFailed(text)) return true;
            const lower = text.toLowerCase();
            return lower.includes('scene 1') && lower.includes(`scene ${totalScenes}`);
        };

        const replyMsg = await pollNewMessage(chat, lastMsgIdBeforeScript, promptStartTime, scriptValidator, 120000);
        if (replyMsg) {
            // Wait an extra 6 seconds for the streamed text to fully settle/finish writing
            console.log('Waiting 6 seconds for script stream to fully settle...');
            await new Promise(resolve => setTimeout(resolve, 6000));
            
            // Fetch messages again to get the final complete text
            const messages = await chat.fetchMessages({ limit: 5 });
            const finalMsg = messages.find(m => m.id.id === replyMsg.id.id) || replyMsg;
            const text = getMessageText(finalMsg);
            if (text && !isGenerationFailed(text)) {
                scriptText = text;
                scriptSuccess = true;
            }
        }
        
        if (!scriptSuccess || !scriptText) {
            console.error('Failed to receive completed script from Meta AI.');
            isGenerating = false;
            statusText = "Error: Script generation failed";
            return;
        }

        console.log('\n--- SCRIPT RECEIVED ---');
        console.log(scriptText);
        console.log('-----------------------\n');

        // Parse scenes using regex
        const sceneRegex = /Scene\s+(\d+)[\s\S]*?Narration\s*:\s*([\s\S]*?)Image\s+Prompt\s*:\s*([\s\S]*?)(?=Scene\s+\d+|$)/gi;
        const scenes = [];
        let match;
        while ((match = sceneRegex.exec(scriptText)) !== null) {
            const number = parseInt(match[1]);
            let narration = match[2].trim();
            let imagePrompt = match[3].trim();
            
            if (narration.toLowerCase().includes('image prompt:')) {
                narration = narration.substring(0, narration.toLowerCase().indexOf('image prompt:')).trim();
            }
            if (imagePrompt.toLowerCase().includes('/imagine')) {
                imagePrompt = imagePrompt.substring(imagePrompt.toLowerCase().indexOf('/imagine')).trim();
            }
            
            scenes.push({ number, narration, imagePrompt });
        }

        console.log(`Successfully parsed ${scenes.length} scenes.`);
        if (scenes.length === 0) {
            console.error('Error: No scenes could be parsed from the script. Exiting.');
            isGenerating = false;
            statusText = "Error: Script parsing failed";
            return;
        }

        // Save narration text and generate voiceover for each scene
        const voiceCode = getVoiceCode(language, voiceover);
        console.log(`Using Voice Code: ${voiceCode} for language: ${language}, voiceover: ${voiceover}`);
        statusText = "Generating scene voiceovers...";
        
        for (const scene of scenes) {
            // Save narration text
            const narrationPath = path.join(outputDir, `scene_${scene.number}_narration.txt`);
            fs.writeFileSync(narrationPath, scene.narration, 'utf8');
            
            // Generate audio
            const audioPath = path.join(outputDir, `scene_${scene.number}_audio.mp3`);
            await generateVoiceover(scene.narration, voiceCode, audioPath);

            // Add a small breather to prevent rate limits/timeouts
            await new Promise(resolve => setTimeout(resolve, 500));
        }

        console.log('\nStarting sequential image generation loop for parsed scenes...\n');

        // Sequential Image Generation loop with retry capabilities
        for (const scene of scenes) {
            statusText = `Generating image for Scene ${scene.number}/${scenes.length}...`;
            console.log(`\n========================================`);
            console.log(`[SCENE ${scene.number}/${scenes.length}]`);
            console.log(`Prompt: "${scene.imagePrompt}"`);
            console.log(`========================================`);

            let imageSaved = false;
            let currentPrompt = scene.imagePrompt;

            // Get the baseline message ID and time before the first attempt for this scene
            const currentMessages = await chat.fetchMessages({ limit: 5 });
            const lastMsgIdBeforeImage = currentMessages.length > 0 ? currentMessages[currentMessages.length - 1].id.id : null;
            const imageStartTime = Math.floor(Date.now() / 1000);

            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`Attempt #${attempt} to generate image for Scene ${scene.number}...`);
                
                // Focus and write the image prompt
                await writeTextToInput(page, inputSelector, currentPrompt);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.keyboard.press('Enter');

                console.log(`Prompt sent! Waiting for Meta AI response...`);
                
                // Image validator function to filter out text placeholders
                const imageValidator = (msg, text) => {
                    if (text && isGenerationFailed(text)) return true;
                    
                    const rawData = msg.rawData || msg._data || {};
                    let hasDirectUrl = false;
                    if (rawData.unifiedResponse) {
                        try {
                            const ur = typeof rawData.unifiedResponse === 'string' ? JSON.parse(rawData.unifiedResponse) : rawData.unifiedResponse;
                            if (ur.sections?.[0]?.view_model?.primitive?.media?.url) {
                                hasDirectUrl = true;
                            }
                        } catch (e) {}
                    }
                    return msg.hasMedia || hasDirectUrl || (text && text.toLowerCase().includes('your image is ready'));
                };

                const replyMsg = await pollNewMessage(chat, lastMsgIdBeforeImage, imageStartTime, imageValidator, 50000);
                if (replyMsg) {
                    const text = getMessageText(replyMsg);
                    
                    // Check if generation is blocked or failed
                    if (isGenerationFailed(text)) {
                        console.log(`Meta AI text reply reports issue: "${text.trim()}"`);
                        if (attempt < 3) {
                            console.log(`Attempt #${attempt} was blocked. Simplifying prompt and retrying...`);
                            currentPrompt = `/imagine a beautiful illustration related to ${topic}, high quality, highly detailed, aspect ratio ${aspect_ratio}`;
                            continue;
                        }
                        break;
                    }

                    // Poll for up to 15 seconds to wait for image media download to settle
                    let downloadSuccess = false;
                    console.log('Waiting for media payload to settle/download...');
                    for (let waitIdx = 0; waitIdx < 8; waitIdx++) {
                        const messages = await chat.fetchMessages({ limit: 5 });
                        const refreshedMsg = messages.find(m => m.id.id === replyMsg.id.id);
                        if (refreshedMsg) {
                            let mediaUrl = null;
                            let mimeType = 'image/jpeg';
                            const rawData = refreshedMsg.rawData || refreshedMsg._data || {};
                            if (rawData.unifiedResponse) {
                                try {
                                    const ur = typeof rawData.unifiedResponse === 'string' ? JSON.parse(rawData.unifiedResponse) : rawData.unifiedResponse;
                                    const media = ur.sections?.[0]?.view_model?.primitive?.media;
                                    if (media && media.url) {
                                        mediaUrl = media.url;
                                        mimeType = media.mime_type || media.mimetype || 'image/jpeg';
                                    }
                                } catch (e) {}
                            }

                            if (mediaUrl || refreshedMsg.hasMedia) {
                                const ext = mimeType.split('/')[1] || 'jpeg';
                                const imgPath = path.join(outputDir, `scene_${scene.number}_image.${ext}`);
                                
                                try {
                                    if (mediaUrl) {
                                        try {
                                            await downloadUrl(mediaUrl, imgPath);
                                            downloadSuccess = true;
                                            console.log(`SUCCESS: Image saved via direct URL download to: ${imgPath}`);
                                        } catch (dlErr) {
                                            console.warn(`WARNING: Direct URL download failed (${dlErr.message || dlErr}). Trying fallback downloadMedia()...`);
                                        }
                                    }
                                    
                                    if (!downloadSuccess) {
                                        const mediaData = await refreshedMsg.downloadMedia();
                                        if (mediaData && mediaData.data) {
                                            fs.writeFileSync(imgPath, Buffer.from(mediaData.data, 'base64'));
                                            downloadSuccess = true;
                                            console.log(`SUCCESS: Image saved via downloadMedia() to: ${imgPath}`);
                                        } else {
                                            console.warn(`WARNING: downloadMedia() returned empty data for Scene ${scene.number}.`);
                                        }
                                    }
                                } catch (mediaErr) {
                                    console.warn(`WARNING: Media download failed for Scene ${scene.number}:`, mediaErr.message || mediaErr);
                                }
                                break;
                            }
                        }
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    if (downloadSuccess) {
                        imageSaved = true;
                        break; // Exit attempt loop on success
                    }
                }

                // If attempt timed out, simplify or send retry command
                if (attempt < 3) {
                    console.log(`Attempt #${attempt} timed out. Sending a direct 'retry' keyword command...`);
                    currentPrompt = 'retry';
                }
            }

            if (!imageSaved) {
                console.warn(`WARNING: Failed to generate image for Scene ${scene.number} after 3 attempts.`);
            }
        }

        console.log(`\n========================================`);
        console.log(`ALL SCENES COMPLETED!`);
        console.log(`Assets folder: ${outputDir}`);
        console.log(`========================================\n`);

        console.log('Starting FFmpeg compilation to merge audios and images into a final video...');
        statusText = "Compiling final video...";

        const segments = [];
        let width = 1080, height = 1920;
        if (aspect_ratio === '16:9') {
            width = 1920;
            height = 1080;
        } else if (aspect_ratio === '1:1') {
            width = 1080;
            height = 1080;
        }

        const files = fs.readdirSync(outputDir);

        for (const scene of scenes) {
            const imgFile = files.find(f => f.startsWith(`scene_${scene.number}_image.`));
            const audioFile = `scene_${scene.number}_audio.mp3`;

            if (!imgFile) {
                console.warn(`WARNING: Missing image for Scene ${scene.number}, skipping segment compilation.`);
                continue;
            }

            const imgPath = path.join(outputDir, imgFile);
            const audioPath = path.join(outputDir, audioFile);

            if (!fs.existsSync(audioPath)) {
                console.warn(`WARNING: Missing audio file for Scene ${scene.number}, skipping segment compilation.`);
                continue;
            }

            // Remove silence (autocut) from audio file
            const audioTrimmedFile = `scene_${scene.number}_audio_trimmed.mp3`;
            const audioTrimmedPath = path.join(outputDir, audioTrimmedFile);
            let activeAudioPath = audioPath;

            try {
                const trimCmd = `ffmpeg -y -i "${audioPath}" -af "silenceremove=start_periods=1:start_threshold=-60dB:stop_periods=-1:stop_threshold=-60dB" "${audioTrimmedPath}"`;
                execSync(trimCmd, { stdio: 'ignore' });
                if (fs.existsSync(audioTrimmedPath) && fs.statSync(audioTrimmedPath).size > 0) {
                    activeAudioPath = audioTrimmedPath;
                    console.log(`Autocut: Trimmed silence from Scene ${scene.number} audio.`);
                }
            } catch (e) {
                console.warn(`WARNING: Autocut silence removal failed for Scene ${scene.number}, using original audio:`, e.message);
            }

            let duration = 3.0;
            try {
                const durationStr = execSync(`ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${activeAudioPath}"`).toString().trim();
                if (durationStr) {
                    duration = parseFloat(durationStr);
                }
            } catch (e) {
                console.warn(`WARNING: Failed to probe duration for ${audioFile}, defaulting to 3.0s:`, e.message);
            }

            const segmentFile = `scene_${scene.number}_temp.mp4`;
            const segmentPath = path.join(outputDir, segmentFile);

            // Automatically rotate zoom/pan effects and directions scene-by-scene
            const effectsList = ['zoom', 'pan', 'zoomout', 'panzoom', 'panzoomout'];
            const directionsList = ['left', 'top', 'right', 'bottom'];
            
            const effect = effectsList[(scene.number - 1) % effectsList.length];
            const direction = directionsList[(scene.number - 1) % directionsList.length];
            
            const totalFrames = Math.ceil(duration * 25);
            let videoFilter = getZoompanFilter(effect, direction, totalFrames, width, height);
            let audioFilter = ``;

            try {
                const cmd = `ffmpeg -y -loop 1 -framerate 25 -i "${imgPath}" -i "${activeAudioPath}" -vf "${videoFilter}" ${audioFilter} -c:v libx264 -pix_fmt yuv420p -c:a aac -t ${duration.toFixed(2)} "${segmentPath}"`;
                console.log(`Compiling Segment ${scene.number}/${scenes.length} (${duration.toFixed(2)}s) with effect: ${effect} (${direction})...`);
                execSync(cmd, { stdio: 'ignore' });
                segments.push(segmentPath);
            } catch (e) {
                console.error(`ERROR: Failed to compile segment for Scene ${scene.number}:`, e.message);
            }
        }

        if (segments.length > 0) {
            console.log('Concatenating video segments into final_video.mp4...');
            const listFilePath = path.join(outputDir, 'concat_list.txt');
            const listContent = segments.map(p => `file '${path.basename(p)}'`).join('\n');
            fs.writeFileSync(listFilePath, listContent, 'utf8');

            const finalVideoPath = path.join(outputDir, 'final_video.mp4');
            try {
                const concatCmd = `ffmpeg -y -f concat -safe 0 -i "${listFilePath}" -c copy "${finalVideoPath}"`;
                execSync(concatCmd, { stdio: 'ignore' });
                console.log(`SUCCESS: Video compiled and saved to: ${finalVideoPath}`);
                statusText = "Pipeline completed successfully!";
            } catch (e) {
                console.error('ERROR: Failed to concatenate video segments:', e.message);
                statusText = "Error during video concatenation";
            }

            // Cleanup temp segment files
            for (const segmentPath of segments) {
                try { fs.unlinkSync(segmentPath); } catch (e) {}
            }
            try { fs.unlinkSync(listFilePath); } catch (e) {}
        } else {
            console.error('ERROR: No video segments compiled successfully.');
            statusText = "Pipeline completed with segment errors";
        }
    } catch (err) {
        console.error('Error during generation script run:', err);
        statusText = "Pipeline failed with errors.";
    } finally {
        isGenerating = false;
    }
}

// Start HTTP Dashboard Server
const http = require('http');
const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        
        if (req.method === 'GET' && url.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
            return;
        }
        
        if (req.method === 'GET' && url.pathname === '/api/screenshot') {
            const screenshotPath = path.join(__dirname, 'live_status.png');
            if (fs.existsSync(screenshotPath)) {
                res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
                res.end(fs.readFileSync(screenshotPath));
            } else {
                res.writeHead(404);
                res.end('No screenshot available yet.');
            }
            return;
        }
        
        if (req.method === 'GET' && url.pathname === '/api/download') {
            const folder = url.searchParams.get('folder');
            const file = url.searchParams.get('file');
            if (!folder || !file) {
                res.writeHead(400);
                res.end('Missing parameters');
                return;
            }
            const filePath = path.join(__dirname, folder, file);
            if (fs.existsSync(filePath)) {
                let contentType = 'application/octet-stream';
                if (file.endsWith('.mp4')) contentType = 'video/mp4';
                else if (file.endsWith('.mp3')) contentType = 'audio/mpeg';
                else if (file.endsWith('.jpeg') || file.endsWith('.jpg')) contentType = 'image/jpeg';
                
                res.writeHead(200, { 'Content-Type': contentType });
                res.end(fs.readFileSync(filePath));
            } else {
                res.writeHead(404);
                res.end('File Not Found');
            }
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                isReady: isClientReady,
                isGenerating: isGenerating,
                statusText: statusText,
                lastFolder: lastFolder
            }));
            return;
        }

        if (req.method === 'GET' && url.pathname === '/api/whatsapp/status') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                isReady: isClientReady,
                qr: currentQrText
            }));
            return;
        }

        if (req.method === 'POST' && url.pathname === '/api/whatsapp/logout') {
            console.log('User requested WhatsApp logout. Clearing session...');
            isClientReady = false;
            currentQrText = null;
            statusText = "Logging out...";
            
            try {
                if (client) {
                    await client.logout();
                    await client.destroy();
                }
            } catch (e) {
                console.error('Error during logout/destroy:', e);
            }
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, message: 'Logged out successfully. Re-initializing...' }));
            
            setTimeout(() => {
                bootClient();
            }, 2000);
            return;
        }
        
        if (req.method === 'GET' && url.pathname === '/api/logs') {
            const startIndex = parseInt(url.searchParams.get('startIndex') || '0');
            let lines = [];
            if (fs.existsSync(logFile)) {
                const rawContent = fs.readFileSync(logFile, 'utf8');
                lines = rawContent.split('\n').filter(l => l.trim() !== '');
            }
            
            const requestedLogs = lines.slice(startIndex).map((text, idx) => ({
                index: startIndex + idx,
                text: text
            }));
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                logs: requestedLogs,
                nextIndex: lines.length
            }));
            return;
        }
        
        if (req.method === 'POST' && url.pathname === '/api/generate') {
            if (!isClientReady) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'WhatsApp client is not ready yet.' }));
                return;
            }
            if (isGenerating) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, message: 'Generation is already in progress.' }));
                return;
            }
            
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const params = JSON.parse(body);
                    if (!params.topic) {
                        res.writeHead(400, { 'Content-Type': 'application/json' });
                        res.end(JSON.stringify({ success: false, message: 'Topic is required.' }));
                        return;
                    }
                    
                    // Trigger asynchronously
                    runGenerationPipeline(params).catch(err => {
                        console.error('Asynchronous pipeline execution failed:', err);
                    });
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, message: 'Generation pipeline triggered.' }));
                } catch (err) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: false, message: 'Invalid request body.' }));
                }
            });
            return;
        }
        
        res.writeHead(404);
        res.end('Not Found');
    } catch (err) {
        console.error('Error handling request:', err);
        res.writeHead(500);
        res.end('Internal Server Error');
    }
});

const port = process.env.PORT || 3000;
server.listen(port, '0.0.0.0', () => {
    console.log(`HTTP Dashboard server listening on port ${port}`);
});

function getPuppeteerArgs() {
    const isRender = !!process.env.RENDER || process.platform !== 'win32';
    const baseArgs = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        '--window-size=1280,800'
    ];
    if (isRender) {
        baseArgs.push(
            '--disable-dev-shm-usage',
            '--disable-gpu',
            '--no-zygote',
            '--single-process',
            '--js-flags=--max-old-space-size=150',
            '--disable-extensions'
        );
    }
    return baseArgs;
}

function bootClient() {
    const mongoUri = process.env.MONGO_URI;
    if (mongoUri) {
        console.log('MONGO_URI found. Configuring RemoteAuth with MongoDB...');
        const mongoose = require('mongoose');
        const { MongoStore } = require('wwebjs-mongo');
        
        // Connect to MongoDB if not already connected
        if (mongoose.connection.readyState === 0) {
            mongoose.connect(mongoUri).then(() => {
                console.log('SUCCESS: Connected to MongoDB session database.');
                const store = new MongoStore({ mongoose: mongoose });
                initializeClientWithRemoteAuth(store);
            }).catch(err => {
                console.error('ERROR: Failed to connect to MongoDB, falling back to LocalAuth:', err.message);
                initLocalClient();
            });
        } else {
            const store = new MongoStore({ mongoose: mongoose });
            initializeClientWithRemoteAuth(store);
        }
    } else {
        console.log('No MONGO_URI provided. Falling back to LocalAuth (local session)...');
        initLocalClient();
    }
}

function initializeClientWithRemoteAuth(store) {
    client = new Client({
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 60000
        }),
        authTimeoutMs: 90000,
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: getPuppeteerArgs()
        }
    });
    
    registerClientEvents(client);
    client.initialize().catch(err => {
        console.error('ERROR: Remote client initialization failed:', err);
        isClientReady = false;
        currentQrText = null;
        statusText = "Connection timed out. Retrying...";
        try { client.destroy(); } catch(e) {}
        setTimeout(() => {
            bootClient();
        }, 5000);
    });
}

function initLocalClient() {
    client = new Client({
        authStrategy: new LocalAuth(),
        authTimeoutMs: 90000,
        puppeteer: {
            headless: true,
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            args: getPuppeteerArgs()
        }
    });
    
    registerClientEvents(client);
    client.initialize().catch(err => {
        console.error('ERROR: Local client initialization failed:', err);
        isClientReady = false;
        currentQrText = null;
        statusText = "Connection timed out. Retrying...";
        try { client.destroy(); } catch(e) {}
        setTimeout(() => {
            bootClient();
        }, 5000);
    });
}

// Start client on boot
bootClient();
