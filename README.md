# Christmas SOL Gift - Setup Guide

## Overview
This is a complete Christmas SOL gifting platform where community members sign up and receive random gifts from other community members. It includes:
- Community signup (name + Solana address)
- Random recipient selection for gifting
- Leaderboard showing top gifters
- Real-time updates

---

## Step 1: Set Up Supabase (Database)

### 1.1 Create Supabase Project
1. Go to **[supabase.com](https://supabase.com)**
2. Click **"Start your project"** → Sign up with email/GitHub
3. Create a new project:
   - **Name:** `christmas-sol-gift` (or whatever you want)
   - **Password:** Create a strong password
   - **Region:** Pick closest to you (Singapore for Brisbane)
   - Click **"Create new project"** (takes ~2 minutes)

### 1.2 Create Database Tables
Once your project is created:

1. Go to **SQL Editor** (left sidebar)
2. Click **"New Query"**
3. Copy & paste this SQL code:

```sql
create table users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  address text not null unique,
  total_gifted numeric default 0,
  created_at timestamp default now()
);

create table gifts (
  id uuid primary key default gen_random_uuid(),
  from_address text not null,
  to_address text not null,
  amount numeric not null,
  created_at timestamp default now()
);

create index on gifts(to_address);
```

4. Click **"Run"**
5. You should see green checkmarks - tables are created ✓

### 1.3 Get Your API Keys
1. Go to **Settings** → **API** (left sidebar)
2. Under "Project API keys", copy:
   - **Project URL** (looks like `https://xxxxx.supabase.co`)
   - **Anon Key** (under "Project API keys" → "anon public")
3. **Save these** - you need them in Step 3

---

## Step 2: Set Up the App Locally

### 2.1 Download Files
- Extract the `christmas-sol-gift.zip` file to your computer
- You'll have:
  - `index.html` (the app)
  - `README.md` (this file)

### 2.2 Add Your Supabase Credentials
1. Open `index.html` in a text editor (Notepad, VS Code, etc.)
2. Find these lines (around line 330):
```javascript
const SUPABASE_URL = 'YOUR_SUPABASE_URL';
const SUPABASE_KEY = 'YOUR_SUPABASE_ANON_KEY';
```

3. Replace with your actual credentials from Step 1.3:
```javascript
const SUPABASE_URL = 'https://xxxxx.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...';
```

4. **Save the file**

### 2.3 Test Locally (Optional)
1. Double-click `index.html` to open it in your browser
2. Try signing up with a test name and address
3. It should work if your credentials are correct

---

## Step 3: Deploy to the Web (Free)

### 3.1 Using Vercel (Recommended - Easy)

**Option A: Via GitHub (Easiest)**
1. Create a GitHub account (free at github.com)
2. Create a new repository
3. Upload `index.html` to it
4. Go to **[vercel.com](https://vercel.com)**
5. Click **"Add New..." → "Project"**
6. Select your GitHub repo
7. Click **"Deploy"**
8. Your app is live! You'll get a URL like `https://christmas-sol-gift.vercel.app`

**Option B: Direct Upload**
1. Go to **[vercel.com](https://vercel.com)**
2. Drag & drop `index.html` → it deploys instantly
3. Get a live URL

### 3.2 Using Netlify (Also Free & Easy)
1. Go to **[netlify.com](https://netlify.com)**
2. Drag & drop your folder or `index.html`
3. Your app is live

### 3.3 Point Your Domain (Optional)
If you have a domain like `christmas-gift.com`:
- Both Vercel and Netlify let you connect custom domains in settings
- It's free and takes 5 minutes

---

## Step 4: Share & Marketing

### Marketing on X (Twitter)
Example posts:
```
🎄 Join our Christmas SOL gift community! Sign up and get randomly selected to receive gifts from other community members this holiday season. Spread the joy! 🎅

Link: [your-url]
```

### Key Points
- Share the signup link everywhere (X, Discord, Telegram)
- Highlight that it's FREE and RANDOM
- Post daily about top gifters to create social proof
- Maybe gift first yourself to start the momentum

---

## How It Works (User Flow)

### For Recipients:
1. Click **"Join Community"**
2. Enter name + Solana address
3. They're registered and can receive gifts anytime

### For Gifters:
1. Click **"Send Gift"**
2. Enter their name + how much SOL
3. App randomly picks someone from the community
4. Copy the recipient's address
5. Send SOL via Phantom/their wallet manually
6. Click **"I've Sent the Gift"** to record it
7. Recipient's leaderboard updates

### Leaderboard:
- Shows all users sorted by total SOL received
- Real-time updates
- Gold/Silver/Bronze badges for top 3

---

## Troubleshooting

### "Invalid Supabase credentials"
- Double-check you copied the URL and Key correctly
- Make sure there are no extra spaces
- Try logging into Supabase dashboard to verify they work

### "This address is already registered"
- They already signed up
- Each Solana address can only sign up once

### Nothing happens when I click buttons
- Check browser console (F12 → Console tab) for errors
- Usually means Supabase credentials are wrong

### I can't see the app
- Make sure you opened `index.html` (not just saved it)
- Use a modern browser (Chrome, Firefox, Safari)

---

## Optional: Token & Smart Contract

Once this is working, you can:
1. Create your actual **Christmas coin** on Solana
2. Airdrop tokens to top gifters
3. Make the leaderboard earn tokens
4. Add token staking/rewards

Want help with that later? Let me know!

---

## Questions?
Good luck! This is now a fully functional Christmas gifting platform. 🎄✨