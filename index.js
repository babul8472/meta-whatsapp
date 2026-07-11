const path = require('path');
const fs = require('fs');

const logFile = path.join(__dirname, 'index_debug.log');
// Clear the log file on launch
try { fs.writeFileSync(logFile, '', 'utf8'); } catch (e) { }

const originalLog = console.log;
console.log = function (...args) {
    originalLog.apply(console, args);
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '\n';
    try { fs.appendFileSync(logFile, msg, 'utf8'); } catch (e) { }
};
const originalError = console.error;
console.error = function (...args) {
    originalError.apply(console, args);
    const msg = '[ERROR] ' + args.map(a => typeof a === 'object' ? JSON.stringify(a) : a).join(' ') + '\n';
    try { fs.appendFileSync(logFile, msg, 'utf8'); } catch (e) { }
};

// Register global error handlers to capture unhandled async crashes
process.on('unhandledRejection', (reason, promise) => {
    console.error('GLOBAL UNHANDLED REJECTION:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('GLOBAL UNCAUGHT EXCEPTION:', err);
});

console.log('Script started. Initializing client in HEADLESS mode...');

const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const https = require('https');
const { execSync, exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

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
                } catch (e) { }
            }, 3000);
        }
    });

    clientInstance.on('auth_failure', (msg) => {
        console.error('AUTHENTICATION FAILURE:', msg);
        statusText = "Authentication failed. Re-initializing...";
    });

    clientInstance.on('loading_screen', (percent, message) => {
        console.log(`Loading Screen: ${percent}% - ${message}`);
        statusText = `Loading WhatsApp Web: ${percent}%`;
    });

    clientInstance.on('disconnected', async (reason) => {
        console.log('WhatsApp Client was disconnected:', reason);
        isClientReady = false;
        currentQrText = null;
        statusText = "Disconnected. Re-initializing WhatsApp Web...";

        try {
            await clientInstance.destroy();
        } catch (e) { }

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

    try { fs.unlinkSync(tempFile); } catch (e) { }

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

// Helper to write text into the chat compose field with simulated human typing
async function writeTextToInput(page, selector, text) {
    await page.waitForSelector(selector);
    // Clear current content first
    await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el) {
            el.focus();
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
        }
    }, selector);

    // If text is very long (e.g. script prompt), write all at once to prevent cursor drift and typos
    if (text.length > 300) {
        await page.evaluate((sel, txt) => {
            const el = document.querySelector(sel);
            if (el) {
                document.execCommand('insertText', false, txt);
            }
        }, selector, text);
    } else {
        // Character by character typing for short prompts
        for (const char of text) {
            await page.evaluate((sel, c) => {
                const el = document.querySelector(sel);
                if (el) {
                    document.execCommand('insertText', false, c);
                }
            }, selector, char);
            // Random delay between 40ms and 120ms to simulate human typing speed (50-100 WPM)
            await new Promise(r => setTimeout(r, Math.random() * 80 + 40));
        }
    }
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

// Construct FFmpeg zoompan filter based on effect and direction (for images)
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

    return `zoompan=z='${z}':x='${x}':y='${y}':d=${totalFrames}:s=${width}x${height}`;
}

// Run generation pipeline on demand
async function runGenerationPipeline({ topic, asset_type, duration, language, voiceover, aspect_ratio }) {
    isGenerating = true;
    statusText = "Starting pipeline...";
    const assetType = (asset_type || 'video').toLowerCase();

    // Clear the debug log for a fresh start on each UI trigger
    try { fs.writeFileSync(logFile, '', 'utf8'); } catch (e) { }
    console.log('--- NEW PIPELINE RUN ---');
    console.log(`Topic: "${topic}"`);
    console.log(`Asset Type: "${assetType}"`);
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
        const wordCount = Math.round(durSeconds * (400 / 60));
        const totalScenes = Math.round(durSeconds / 3);
        const sceneDuration = 3.0;

        const promptInstruction = assetType === 'video'
            ? `Video Prompt: generate a video of [English prompt — character(s) with fixed appearance if applicable, action/expression, setting, camera angle (close-up/wide/medium/POV), lighting mood matching genre, art style: cinematic realistic video style, vertical 9:16 composition, no text or watermark in video]`
            : `Image Prompt: /imagine [English prompt — character(s) with fixed appearance if applicable, action/expression, setting, camera angle (close-up/wide/medium/POV), lighting mood matching genre, art style: cinematic realistic photo style, vertical 9:16 composition, no text or watermark in image]`;

        const finalCheckInstruction = assetType === 'video'
            ? `Make sure each Video Prompt is formatted EXACTLY starting with: generate a video of`
            : `Make sure each Image Prompt is formatted EXACTLY starting with: /imagine`;

        // Create script prompt based on input parameters and strict custom formatting rules
        const scriptPrompt = `[CONTEXT MEMORY: Please remember this conversation and the guidelines below for all subsequent messages.]

Topic: "${topic}"
Duration: ${durSeconds} seconds
Language: ${language}
Voiceover Gender: ${voiceover}
Aspect Ratio: ${aspect_ratio}

You are an expert short-form video scriptwriter specializing in viral social media reels across all genres (comedy, drama, motivational, horror, educational, emotional, mythological, etc.).

CRITICAL RULE FOR NARRATION STYLE (applies to every single scene, no exceptions):
- Each scene's narration must be ONE flowing sentence, not multiple short fragments separated by full stops.
- Connect ideas using commas, "and", "where", "as", or an em dash (—) instead of breaking them into separate short sentences.
- Avoid choppy 3-4 word sentences (e.g. "One country. One heartbeat." is WRONG).
- Instead write it as a single connected sentence (e.g. "One country, a billion stories, and a single heartbeat" is CORRECT).
- Keep each scene's narration under 15 words total, but structured as one smooth, speakable sentence — not a list of fragments.
- The tone should sound natural when read aloud by a text-to-speech voice, with a clear rhythm and no abrupt pauses.

NARRATION STYLE EXAMPLES:
* ORIGINAL (choppy - WRONG): "One country. One billion stories. One heartbeat. Welcome to India."
  REWRITTEN (flowing - CORRECT): "One country, a billion stories, and a single heartbeat — welcome to India."
* ORIGINAL (choppy - WRONG): "Deserts of Rajasthan. Green tea gardens of Assam. Every land has a soul."
  REWRITTEN (flowing - CORRECT): "From the deserts of Rajasthan to the green tea gardens of Assam, every land here has its own soul."
* ORIGINAL (choppy - WRONG): "Twenty eight states. Eight union territories. Hundreds of languages. One unity."
  REWRITTEN (flowing - CORRECT): "Twenty-eight states, eight union territories, hundreds of languages — yet one unity."
* ORIGINAL (choppy - WRONG): "Ancient temples stand beside glass skyscrapers. Past and future shake hands."
  REWRITTEN (flowing - CORRECT): "Ancient temples stand beside glass skyscrapers, where past and future shake hands."

STEP 1 - ANALYZE TOPIC:
Identify genre/tone, number of characters needed (0 if narration-only/educational), and setting/time period implied by the topic.

STEP 2 - TITLE:
Refine the topic into a short, catchy, curiosity-driven title (max 8 words) fitting the identified genre.

STEP 3 - CHARACTER SETUP (skip only if topic has zero characters):
For each character define:
- Name (culturally appropriate to the topic/language)
- One-line personality trait or role
- Fixed visual appearance (clothing, build, distinguishing feature) — reuse this EXACT description in every visual prompt where the character appears.

STEP 4 - SCRIPT:
Write a script of at least ${wordCount} words (~6.5 words per second of narration, scaled to ${durSeconds} seconds) in ${language}.
- Write narration entirely in the native script of ${language} (e.g. Devanagari for Hindi) — do NOT romanize/transliterate into English letters, and do NOT mix in English words unless there is no natural equivalent.
- Structure: Hook → Setup → Development → Peak moment → Closing line, matching genre.
- Every line must be short and conversational — like a quick spoken thought, not a written sentence. Example of correct length: "राहुल अचानक रुक गया।" Example of WRONG length (too long, never write like this): "राहुल जो हमेशा सबसे आगे रहता था, अचानक बीच रास्ते में रुक गया और सोचने लगा।"
- Avoid tongue-twisting or hard-to-pronounce word clusters — this will be read aloud by TTS.
- Write numbers, dates, and abbreviations in words, not digits.

STEP 5 - SCENE BREAKDOWN:
Split the script into exactly ${totalScenes} consecutive scenes (~${sceneDuration} seconds each).
- HARD LIMIT: under 15 words per scene narration, always. No scene may exceed 15 words, under any circumstance.
- Each scene's narration must strictly be one flowing sentence (applying the NARRATION STYLE rules).
- If a moment feels like it needs more words, break it into two shorter scenes instead — never stretch one scene's narration to cover it.
- Distribute the ${wordCount}-word script across ${totalScenes} scenes as evenly as timing allows — do not pad or shorten scenes just to hit a count.
- Carry forward the same character(s) with their EXACT fixed visual description, if applicable.
- Ensure clear visual progression — no two consecutive scenes should look visually identical (vary angle, action, expression, setting, or time of day).
- Match emotional tone/genre visually and narratively.
- Never cut a sentence awkwardly across two scenes — each scene's narration must be a complete, natural short phrase.

For each scene, output EXACTLY in this format (no extra text/headers, no explanations outside scene blocks):

Scene {number}
Narration: [narration text in ${language}, native script only, under 15 words maximum, one flowing sentence]
${promptInstruction}

Ensure exactly ${totalScenes} scenes, numbered 1 to ${totalScenes}, covering hook → setup → development → peak → closing, regardless of topic or genre.

FINAL CHECK before output (mandatory — recount every scene): Go through all ${totalScenes} scenes one by one and count the words in each narration. If any scene has 15 or more words, rewrite it shorter before giving the final output. Confirm all narration is in ${language} native script, character descriptions are consistent, and there are exactly ${totalScenes} scenes. ${finalCheckInstruction}`;

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

        console.log('Sending /reset-ai to Meta AI to start a new chat session...');
        try {
            await client.sendMessage('13135550002@c.us', '/reset-ai');
            console.log('SUCCESS: /reset-ai command sent.');
            await new Promise(resolve => setTimeout(resolve, 4000));
        } catch (resetErr) {
            console.warn('WARNING: Failed to send /reset-ai command:', resetErr.message || resetErr);
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

        // Parse scenes using regex (handling optional markdown bold asterisks and supporting Video or Image prompt keywords)
        const sceneRegex = /(?:\*\*|\b)Scene\s+(\d+)[\s\S]*?Narration\s*\*?\*?\s*:\s*([\s\S]*?)(?:Video|Image)\s+Prompt\s*\*?\*?\s*:\s*([\s\S]*?)(?=(?:\*\*|\b)Scene\s+\d+|$)/gi;
        const scenes = [];
        let match;
        while ((match = sceneRegex.exec(scriptText)) !== null) {
            const number = parseInt(match[1]);
            let narration = match[2].trim();
            let scenePrompt = match[3].trim();

            if (narration.toLowerCase().includes('video prompt:')) {
                narration = narration.substring(0, narration.toLowerCase().indexOf('video prompt:')).trim();
            }
            if (narration.toLowerCase().includes('image prompt:')) {
                narration = narration.substring(0, narration.toLowerCase().indexOf('image prompt:')).trim();
            }

            // Clean up narration text: remove lines containing "word count", "wordcount", "words", tick marks, etc.
            narration = narration.split('\n')
                .map(line => line.trim())
                .filter(line => {
                    const l = line.toLowerCase();
                    return !l.includes('word count') && !l.includes('wordcount') && !l.includes('words:') && !l.startsWith('✓') && !l.startsWith('word');
                })
                .join(' ')
                .replace(/\*+/g, '') // remove markdown bold/italic asterisks
                .replace(/[\[\(\{\s]*\d+\s*words?[\]\)\}\s]*/gi, '') // remove (9 words), [9 words], etc.
                .trim();

            // Clean up scenePrompt: remove confirmation, footer text, or markdown lines
            const promptLines = scenePrompt.split('\n');
            const cleanPromptLines = [];
            for (const line of promptLines) {
                const trimmed = line.trim();
                const lower = trimmed.toLowerCase();
                // Stop capturing if we hit confirmation keywords, empty lines after prompt, or dividers
                if (lower.startsWith('**confirmation**') ||
                    lower.startsWith('confirmation') ||
                    lower.startsWith('ready to') ||
                    lower.startsWith('- ') ||
                    trimmed.startsWith('---') ||
                    trimmed === '') {
                    break;
                }
                cleanPromptLines.push(trimmed);
            }
            scenePrompt = cleanPromptLines.join(' ').replace(/\*+/g, '').replace(/`+/g, '').trim();

            if (assetType === 'video') {
                if (scenePrompt.toLowerCase().includes('generate a video of')) {
                    scenePrompt = scenePrompt.substring(scenePrompt.toLowerCase().indexOf('generate a video of')).trim();
                } else {
                    // Try to match variations of generate a video
                    const genIndex = scenePrompt.toLowerCase().indexOf('generate');
                    if (genIndex !== -1) {
                        scenePrompt = scenePrompt.substring(genIndex).trim();
                    }
                }
                // Strict check: if not starting with "generate a video of", prepend it
                if (!scenePrompt.toLowerCase().startsWith('generate a video of')) {
                    scenePrompt = scenePrompt.replace(/^[^a-zA-Z]+/g, ''); // remove non-alpha chars like colons, slashes
                    if (scenePrompt.toLowerCase().startsWith('video of')) {
                        scenePrompt = 'generate a ' + scenePrompt;
                    } else {
                        scenePrompt = 'generate a video of ' + scenePrompt;
                    }
                }
            } else {
                const words = scenePrompt.split(/\s+/);
                if (words.length > 0 && words[0].toLowerCase().includes('imagine')) {
                    let restWords = words.slice(1);
                    // Clean up common leakages from memory instructions
                    if (restWords.length >= 2 && restWords[0].toLowerCase() === 'our' && restWords[1].toLowerCase() === 'chat') {
                        restWords = restWords.slice(2);
                    } else if (restWords.length >= 1 && restWords[0].toLowerCase() === 'chat') {
                        restWords = restWords.slice(1);
                    } else if (restWords.length >= 1 && restWords[0].toLowerCase() === 'our') {
                        restWords = restWords.slice(1);
                    }
                    scenePrompt = `/imagine ` + restWords.join(' ');
                } else if (!scenePrompt.toLowerCase().startsWith('/imagine')) {
                    scenePrompt = `/imagine ${scenePrompt.replace(/^[^a-zA-Z]+/g, '')}`;
                }
            }

            scenes.push({ number, narration, prompt: scenePrompt });
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

        console.log(`\nStarting sequential ${assetType} generation loop for parsed scenes...\n`);

        // Sequential Media Generation loop with retry capabilities
        for (const scene of scenes) {
            statusText = `Generating ${assetType} for Scene ${scene.number}/${scenes.length}...`;
            console.log(`\n========================================`);
            console.log(`[SCENE ${scene.number}/${scenes.length}]`);
            console.log(`Prompt: "${scene.prompt}"`);
            console.log(`========================================`);

            let mediaSaved = false;
            let currentPrompt = scene.prompt;
            if (assetType === 'video') {
                if (!currentPrompt.toLowerCase().startsWith('generate a video of')) {
                    currentPrompt = `generate a video of ${currentPrompt}`;
                }
            } else {
                if (!currentPrompt.toLowerCase().startsWith('/imagine')) {
                    currentPrompt = `/imagine ${currentPrompt}`;
                }
            }

            // Get the baseline message ID and time before the first attempt for this scene
            const currentMessages = await chat.fetchMessages({ limit: 5 });
            const lastMsgIdBeforeMedia = currentMessages.length > 0 ? currentMessages[currentMessages.length - 1].id.id : null;
            const mediaStartTime = Math.floor(Date.now() / 1000);

            for (let attempt = 1; attempt <= 3; attempt++) {
                console.log(`Attempt #${attempt} to generate ${assetType} for Scene ${scene.number}...`);

                // Focus and type the prompt like a human
                await writeTextToInput(page, inputSelector, currentPrompt);
                await new Promise(resolve => setTimeout(resolve, 1000));
                await page.keyboard.press('Enter');

                console.log(`Prompt sent! Waiting for Meta AI response...`);

                // Media validator function to filter out text placeholders
                const mediaValidator = (msg, text) => {
                    if (text && isGenerationFailed(text)) return true;

                    const rawData = msg.rawData || msg._data || {};
                    let hasDirectUrl = false;
                    if (rawData.unifiedResponse) {
                        try {
                            const ur = typeof rawData.unifiedResponse === 'string' ? JSON.parse(rawData.unifiedResponse) : rawData.unifiedResponse;
                            if (ur.sections?.[0]?.view_model?.primitive?.media?.url) {
                                hasDirectUrl = true;
                            }
                        } catch (e) { }
                    }
                    const readyKeyword = assetType === 'video' ? 'your video is ready' : 'your image is ready';
                    return msg.hasMedia || hasDirectUrl || (text && text.toLowerCase().includes(readyKeyword));
                };

                const replyMsg = await pollNewMessage(chat, lastMsgIdBeforeMedia, mediaStartTime, mediaValidator, 60000);
                if (replyMsg) {
                    const text = getMessageText(replyMsg);

                    // Check if generation is blocked or failed
                    if (isGenerationFailed(text)) {
                        console.log(`Meta AI text reply reports issue: "${text.trim()}"`);
                        if (attempt < 3) {
                            console.log(`Attempt #${attempt} was blocked. Simplifying prompt and retrying...`);
                            if (assetType === 'video') {
                                currentPrompt = `generate a video of a beautiful landscape related to ${topic}, aspect ratio ${aspect_ratio}`;
                            } else {
                                currentPrompt = `/imagine a beautiful landscape related to ${topic}, aspect ratio ${aspect_ratio}`;
                            }
                            continue;
                        }
                        break;
                    }

                    // Poll for up to 20 seconds to wait for media download to settle
                    let downloadSuccess = false;
                    console.log('Waiting for media payload to settle/download...');
                    for (let waitIdx = 0; waitIdx < 10; waitIdx++) {
                        const messages = await chat.fetchMessages({ limit: 5 });
                        const refreshedMsg = messages.find(m => m.id.id === replyMsg.id.id);
                        if (refreshedMsg) {
                            let mediaUrl = null;
                            let mimeType = assetType === 'video' ? 'video/mp4' : 'image/jpeg';
                            const rawData = refreshedMsg.rawData || refreshedMsg._data || {};
                            if (rawData.unifiedResponse) {
                                try {
                                    const ur = typeof rawData.unifiedResponse === 'string' ? JSON.parse(rawData.unifiedResponse) : rawData.unifiedResponse;
                                    const media = ur.sections?.[0]?.view_model?.primitive?.media;
                                    if (media && media.url) {
                                        mediaUrl = media.url;
                                        mimeType = media.mime_type || media.mimetype || (assetType === 'video' ? 'video/mp4' : 'image/jpeg');
                                    }
                                } catch (e) { }
                            }

                            if (mediaUrl || refreshedMsg.hasMedia) {
                                const ext = mimeType.split('/')[1] || (assetType === 'video' ? 'mp4' : 'jpeg');
                                const sceneMediaPath = path.join(outputDir, `scene_${scene.number}_asset.${ext}`);

                                try {
                                    if (mediaUrl) {
                                        try {
                                            await downloadUrl(mediaUrl, sceneMediaPath);
                                            downloadSuccess = true;
                                            console.log(`SUCCESS: Asset saved via direct URL download to: ${sceneMediaPath}`);
                                        } catch (dlErr) {
                                            console.warn(`WARNING: Direct URL download failed (${dlErr.message || dlErr}). Trying fallback downloadMedia()...`);
                                        }
                                    }

                                    if (!downloadSuccess) {
                                        const mediaData = await refreshedMsg.downloadMedia();
                                        if (mediaData && mediaData.data) {
                                            mimeType = mediaData.mimetype || mimeType; // Update mimeType from mediaData
                                            fs.writeFileSync(sceneMediaPath, Buffer.from(mediaData.data, 'base64'));
                                            downloadSuccess = true;
                                            console.log(`SUCCESS: Asset saved via downloadMedia() to: ${sceneMediaPath}`);
                                        } else {
                                            console.warn(`WARNING: downloadMedia() returned empty data for Scene ${scene.number}.`);
                                        }
                                    }

                                    // Verify that the media is of expected type (image vs video)
                                    if (downloadSuccess) {
                                        const expectedTypePrefix = assetType === 'video' ? 'video/' : 'image/';
                                        if (mimeType.toLowerCase().startsWith(expectedTypePrefix)) {
                                            // Verify file exists and is larger than 10KB
                                            if (fs.existsSync(sceneMediaPath)) {
                                                const stats = fs.statSync(sceneMediaPath);
                                                if (stats.size > 10240) { // 10KB
                                                    console.log(`SUCCESS: Asset verified (mime: ${mimeType}, size: ${stats.size} bytes)`);
                                                } else {
                                                    console.warn(`WARNING: Downloaded asset file is too small (${stats.size} bytes). Rejecting and retrying...`);
                                                    downloadSuccess = false;
                                                    try { fs.unlinkSync(sceneMediaPath); } catch (e) { }
                                                }
                                            } else {
                                                console.warn(`WARNING: Asset file not found after download.`);
                                                downloadSuccess = false;
                                            }
                                        } else {
                                            console.warn(`WARNING: Media is not of expected type ${expectedTypePrefix} (mime_type: ${mimeType}). Rejecting and retrying...`);
                                            downloadSuccess = false;
                                            try { fs.unlinkSync(sceneMediaPath); } catch (e) { }
                                        }
                                    }
                                } catch (mediaErr) {
                                    console.warn(`WARNING: Media download failed for Scene ${scene.number}:`, mediaErr.message || mediaErr);
                                    downloadSuccess = false;
                                }
                                break;
                            }
                        }
                        await new Promise(r => setTimeout(r, 2000));
                    }

                    if (downloadSuccess) {
                        mediaSaved = true;
                        break; // Exit attempt loop on success
                    }
                }

                // If attempt timed out, simplify or send retry command
                if (attempt < 3) {
                    console.log(`Attempt #${attempt} timed out. Sending a direct 'retry' keyword command...`);
                    currentPrompt = 'retry with polished new updated prompt or make a new updated prompt for the video and then retry again';
                }
            }

            if (!mediaSaved) {
                console.warn(`WARNING: Failed to generate asset for Scene ${scene.number} after 3 attempts.`);
            }
        }

        console.log(`\n========================================`);
        console.log(`ALL SCENES COMPLETED!`);
        console.log(`Assets folder: ${outputDir}`);
        console.log(`========================================\n`);

        console.log(`Starting FFmpeg compilation to merge audios and ${assetType}s into a final video...`);
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
            const assetFile = files.find(f => f.startsWith(`scene_${scene.number}_asset.`));
            const audioFile = `scene_${scene.number}_audio.mp3`;

            if (!assetFile) {
                console.warn(`WARNING: Missing asset for Scene ${scene.number}, skipping segment compilation.`);
                continue;
            }

            const sceneMediaPath = path.join(outputDir, assetFile);
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

            if (assetType === 'video') {
                try {
                    // Loop the video infinitely and merge it with the audio, cropping it to target resolution
                    const cmd = `ffmpeg -y -stream_loop -1 -i "${sceneMediaPath}" -i "${activeAudioPath}" -vf "scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}" -c:v libx264 -pix_fmt yuv420p -c:a aac -t ${duration.toFixed(2)} "${segmentPath}"`;
                    console.log(`Compiling Segment ${scene.number}/${scenes.length} (${duration.toFixed(2)}s)...`);
                    execSync(cmd, { stdio: 'ignore' });
                    segments.push(segmentPath);
                } catch (e) {
                    console.error(`ERROR: Failed to compile segment for Scene ${scene.number}:`, e.message);
                }
            } else {
                // Image to Video Zoompan animation
                const effectsList = ['zoom', 'pan', 'zoomout', 'panzoom', 'panzoomout'];
                const directionsList = ['left', 'top', 'right', 'bottom'];

                const effect = effectsList[(scene.number - 1) % effectsList.length];
                const direction = directionsList[(scene.number - 1) % directionsList.length];

                const totalFrames = Math.ceil(duration * 25);
                let videoFilter = getZoompanFilter(effect, direction, totalFrames, width, height);

                try {
                    const cmd = `ffmpeg -y -loop 1 -framerate 25 -i "${sceneMediaPath}" -i "${activeAudioPath}" -vf "${videoFilter}" -c:v libx264 -pix_fmt yuv420p -c:a aac -t ${duration.toFixed(2)} "${segmentPath}"`;
                    console.log(`Compiling Segment ${scene.number}/${scenes.length} (${duration.toFixed(2)}s) with effect: ${effect} (${direction})...`);
                    execSync(cmd, { stdio: 'ignore' });
                    segments.push(segmentPath);
                } catch (e) {
                    console.error(`ERROR: Failed to compile segment for Scene ${scene.number}:`, e.message);
                }
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
                try { fs.unlinkSync(segmentPath); } catch (e) { }
            }
            try { fs.unlinkSync(listFilePath); } catch (e) { }
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

function cleanSessionLocks() {
    const authDir = path.join(__dirname, '.wwebjs_auth');
    if (!fs.existsSync(authDir)) return;

    function deleteLocks(dir) {
        const files = fs.readdirSync(dir);
        for (const file of files) {
            const fullPath = path.join(dir, file);
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
                deleteLocks(fullPath);
            } else if (file === 'SingletonLock' || file === 'LOCK') {
                try {
                    fs.unlinkSync(fullPath);
                    console.log(`Deleted lock file: ${fullPath}`);
                } catch (e) {
                    // Ignore if locked by a running process
                }
            }
        }
    }
    try {
        deleteLocks(authDir);
    } catch (e) {
        console.warn('Warning: Error cleaning session locks:', e.message);
    }
}

function bootClient() {
    cleanSessionLocks();
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
            args: getPuppeteerArgs(),
            defaultViewport: null
        }
    });

    registerClientEvents(client);
    client.initialize().catch(err => {
        console.error('ERROR: Remote client initialization failed:', err);
        isClientReady = false;
        currentQrText = null;
        statusText = "Connection timed out. Retrying...";
        try { client.destroy(); } catch (e) { }
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
            args: getPuppeteerArgs(),
            defaultViewport: null
        }
    });

    registerClientEvents(client);
    client.initialize().catch(err => {
        console.error('ERROR: Local client initialization failed:', err);
        isClientReady = false;
        currentQrText = null;
        statusText = "Connection timed out. Retrying...";
        try { client.destroy(); } catch (e) { }
        setTimeout(() => {
            bootClient();
        }, 5000);
    });
}

// Watchdog interval to resolve ready event hangs on 100% loading
setInterval(async () => {
    if (client && client.pupPage && !isClientReady) {
        try {
            const triggered = await client.pupPage.evaluate(() => {
                try {
                    const Socket = window.require('WAWebSocketModel')?.Socket;
                    if (Socket && Socket.hasSynced && typeof window.onAppStateHasSyncedEvent === 'function') {
                        window.onAppStateHasSyncedEvent();
                        return true;
                    }
                } catch (e) { }
                return false;
            });
            if (triggered) {
                console.log('Watchdog: Force-triggered app state sync ready sequence.');
            }
        } catch (e) {
            // Ignore evaluate errors during early navigation
        }
    }
}, 3000);

// Start client on boot
bootClient();
