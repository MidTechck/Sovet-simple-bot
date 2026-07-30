import os
import requests
import json
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "")
NVIDIA_API_KEY = os.environ.get("NVIDIA_API_KEY", "")

SYSTEM_PROMPT = """You are a friendly, concise human representative for Trustwave Technologies Ltd on WhatsApp. 
Keep your responses short, natural, direct, and conversational (1-2 sentences max). 
Never use robotic corporate intros like "Hello, I am the assistant for...". Talk like a real person typing quickly on a phone.
If you don't know an exact price for a custom installation, say: "I can have our team calculate a quote for your setup and get back to you shortly."
Services provided: CCTV cameras, access control systems, IT security services, and Starlink setups."""

USER_MESSAGE = "Hello, how much is Starlink installation?"

def test_gemini_api():
    print("--------------------------------------------------")
    if not GEMINI_API_KEY:
        print("❌ ERROR: GEMINI_API_KEY is missing! Check your .env file.")
        return False

    print(f"🔑 Gemini API Key found: {GEMINI_API_KEY[:6]}...{GEMINI_API_KEY[-4:]}")
    print("Testing Gemini model: gemini-1.5-flash ...")
    
    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key={GEMINI_API_KEY}"
    headers = {"Content-Type": "application/json"}
    
    payload = {
        "contents": [
            {"role": "user", "parts": [{"text": SYSTEM_PROMPT}]},
            {"role": "model", "parts": [{"text": "Understood. I will act as the human representative."}]},
            {"role": "user", "parts": [{"text": USER_MESSAGE}]}
        ]
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=15)
        if response.status_code == 200:
            data = response.json()
            reply = data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')
            print("✅ SUCCESS! Gemini responded:\n")
            print(f"\"{reply.strip()}\"\n")
            return True
        else:
            print(f"❌ Gemini Failed with status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"❌ Exception occurred with Gemini: {e}")
    
    return False

def test_nvidia_api():
    print("--------------------------------------------------")
    if not NVIDIA_API_KEY:
        print("❌ ERROR: NVIDIA_API_KEY is missing! Check your .env file.")
        return False

    print(f"🔑 Nvidia API Key found: {NVIDIA_API_KEY[:6]}...{NVIDIA_API_KEY[-4:]}")
    
    model = "nvidia/nemotron-4-34b-instruct"
    print(f"Testing Nvidia fallback model: {model} ...")

    url = "https://integrate.api.nvidia.com/v1/chat/completions"
    headers = {
        "Authorization": f"Bearer {NVIDIA_API_KEY.strip()}",
        "Content-Type": "application/json"
    }

    test_messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": USER_MESSAGE}
    ]

    payload = {
        "model": model,
        "messages": test_messages,
        "max_tokens": 150,
        "temperature": 0.7
    }

    try:
        response = requests.post(url, headers=headers, json=payload, timeout=15)
        if response.status_code == 200:
            data = response.json()
            reply = data['choices'][0]['message']['content']
            print("✅ SUCCESS! Nvidia responded:\n")
            print(f"\"{reply.strip()}\"\n")
            return True
        else:
            print(f"❌ Nvidia Failed with status {response.status_code}: {response.text}")
    except Exception as e:
        print(f"❌ Exception occurred with Nvidia {model}: {e}")
    
    return False

if __name__ == "__main__":
    print("🚀 Starting API Health Checks...")
    gemini_status = test_gemini_api()
    nvidia_status = test_nvidia_api()
    
    print("--------------------------------------------------")
    if gemini_status and nvidia_status:
        print("🌟 ALL SYSTEMS GO! Both primary and fallback APIs are working perfectly.")
    elif gemini_status or nvidia_status:
        print("⚠️ PARTIAL SUCCESS: One of your APIs is down, but the fallback system will keep the bot running.")
    else:
        print("🚨 CRITICAL ERROR: Both APIs failed. The bot will rely entirely on local keyword fallbacks.")


