// Creates sample shop-counter voice clips with Gnani text-to-speech, so you can
// test /api/voice without recording yourself. Run: npm run make-audio
// Output: test-audio/*.wav (git-ignored). Uses a little Gnani credit per clip.
import { mkdir, writeFile } from 'node:fs/promises';

const key = process.env.GNANI_API_KEY;
if (!key) {
  console.error('GNANI_API_KEY is not set in .env');
  process.exit(1);
}

const clips = [
  {
    file: 'en-ramesh-khata.wav',
    language: 'en-IN',
    voice: 'Pranav',
    text: 'Ramesh, two kilo rice at sixty rupees per kilo, one litre sunflower oil for one hundred forty five rupees, and three soaps at forty rupees each. Put it on khata.',
  },
  {
    file: 'hi-ramesh-khata.wav',
    language: 'hi-IN',
    voice: 'Deepak',
    text: 'रमेश, दो किलो चावल साठ रुपये किलो, एक लीटर तेल एक सौ पैंतालीस रुपये, और तीन साबुन चालीस रुपये वाले। खाते में लिख दो।',
  },
  {
    file: 'te-ramesh-khata.wav',
    language: 'te-IN',
    voice: 'Lavanya',
    text: 'రమేష్, రెండు కిలోల బియ్యం కిలో అరవై రూపాయలు, ఒక లీటర్ నూనె నూట నలభై ఐదు రూపాయలు, మూడు సబ్బులు ఒక్కొక్కటి నలభై రూపాయలు. ఖాతాలో రాయండి.',
  },
  {
    file: 'en-walkin-cash.wav',
    language: 'en-IN',
    voice: 'Kaveri',
    text: 'Half kilo sugar at forty eight rupees a kilo and two packets of milk at twenty seven rupees each. Cash payment.',
  },
];

await mkdir('test-audio', { recursive: true });

// Gnani allows one active request at a time, so the clips are made one by one.
for (const clip of clips) {
  const res = await fetch('https://api.vachana.ai/api/v1/tts/inference', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': key },
    body: JSON.stringify({
      text: clip.text,
      voice: clip.voice,
      model: 'timbre-v2.5',
      language: clip.language,
      speed: 1.0,
      audio_config: { sample_rate: 16000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'wav' },
    }),
  });
  if (!res.ok) {
    console.error(`✘ ${clip.file}: HTTP ${res.status} ${await res.text()}`);
    continue;
  }
  const audio = Buffer.from(await res.arrayBuffer());
  await writeFile(`test-audio/${clip.file}`, audio);
  console.log(`✔ test-audio/${clip.file} (${Math.round(audio.length / 1024)} KB)  "${clip.text}"`);
}
