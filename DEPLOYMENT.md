# Deployment Guide - Christmas SOL Gift Platform

## Overview
This platform now uses:
- **Frontend**: Vercel (your existing setup)
- **Backend**: Railway (simple Node.js server)
- **Database**: SQLite (in-memory, no external service)

This works everywhere globally without VPN! ✨

---

## Step 1: Deploy Backend to Railway

### 1.1 Create Railway Account
1. Go to **[railway.app](https://railway.app)**
2. Click **"Login with GitHub"** (easiest)
3. Authorize Railway to access GitHub

### 1.2 Deploy the Backend

1. In Railway, click **"New Project"** → **"Deploy from GitHub"**
2. Select your `christmas-sol-gift` GitHub repo
3. Railway will automatically detect the Node.js project
4. Click **"Deploy"** - it takes ~2 minutes

### 1.3 Get Your Railway URL

1. Once deployed, go to your project in Railway
2. Click on the **"christmas-sol-gift-backend"** service
3. Look for **"Deployments"** → click the active deployment
4. Copy the **"Public URL"** (looks like `https://something-production.railway.app`)

---

## Step 2: Update Your Frontend

### 2.1 Update index.html
1. Open `index.html` in your text editor
2. Find this line (around line 655):
```javascript
const API_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://your-railway-url.railway.app';
```

3. Replace `https://your-railway-url.railway.app` with your actual Railway URL:
```javascript
const API_URL = window.location.hostname === 'localhost' ? 'http://localhost:3000' : 'https://christmas-sol-gift-production.railway.app';
```

4. Save the file

### 2.2 Push to GitHub
```bash
git add index.html
git commit -m "Update backend API URL for Railway deployment"
git push
```

### 2.3 Vercel Auto-Deploys
- Within 30 seconds, your live site will update
- Everything now works! 🎉

---

## Step 3: Test It

1. Visit your **Vercel URL** (e.g., `https://christmas-sol-gift.vercel.app`)
2. Try joining the community
3. Should work instantly! ✅

---

## Files in This Package

- **index.html** - Your frontend (updated to use Node.js backend)
- **server.js** - Node.js backend (handles database & API)
- **package.json** - Dependencies for Node.js
- **README.md** - Original setup guide
- **DEPLOYMENT.md** - This file

---

## Troubleshooting

### "Connection error" after deployment
- Check that your Railway URL is correct in `index.html`
- Make sure Railway deployment is "Running" (green status)
- Wait 2-3 mins for Railway to fully initialize

### Railway shows error
- Go to Railway dashboard → your project → Logs
- Check for errors in the build/runtime logs
- Usually just need to wait a bit longer

### Still getting errors?
- Open browser console (F12)
- Look for the exact error message
- Check that your API_URL is correct

---

## What's Different Now?

| Before | Now |
|--------|-----|
| ❌ Supabase (blocked in Australia) | ✅ Railway backend (global access) |
| ❌ Requires VPN | ✅ Works everywhere |
| ❌ External database | ✅ Simple in-memory DB |
| ✅ Easy to scale | ✅ Easy to scale |

---

## Next Steps

1. Deploy to Railway (this guide)
2. Update HTML with Railway URL
3. Push to GitHub
4. Test on your live Vercel site
5. Share and start marketing! 🚀

---

## Support

If anything doesn't work, the browser console (F12) will show the real error. That's your best troubleshooting tool!

Good luck! 🎄✨
