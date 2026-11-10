# One clip per scene so every cut lands on its line. Voice: Andrew (en-US-AndrewNeural).
import asyncio, json, os, edge_tts
VOICE, RATE = "en-US-AndrewNeural", "+4%"
async def main():
    os.makedirs("vo", exist_ok=True)
    for i, l in enumerate(json.load(open("lines.json", encoding="utf-8"))):
        out = f"vo/{i:02d}-{l['id']}.mp3"
        for attempt in range(5):
            try:
                await edge_tts.Communicate(l["say"], VOICE, rate=RATE).save(out)
                if os.path.getsize(out) > 2000: break
            except Exception as e:
                print("retry", l["id"], type(e).__name__)
            await asyncio.sleep(2 + attempt * 2)
        print("ok", l["id"])
asyncio.run(main())
