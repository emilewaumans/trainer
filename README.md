# Trainer

My training app for iPhone: schedule, workouts, nutrition, goals and daily check-ins.
A web app (PWA) hosted on GitHub Pages. Plain HTML/CSS/JavaScript, no build step.

## Files

| File | What it does |
|---|---|
| `index.html` | The page (header, tab bar) |
| `styles.css` | Dark design, big buttons |
| `app.js` | Loads the plan and draws every screen |
| `plan.json` | **This week's plan from my coach**, the only file that changes weekly |
| `manifest.json` | App name, icon and colours for the home screen |
| `sw.js` | Makes the app work offline |
| `icons/` | Home-screen icons |

## Updating the plan each week

**Option A: upload to GitHub (the app on every device gets it)**
1. Save the coach's JSON as a file called exactly `plan.json`.
2. On github.com open this repository → **Add file** → **Upload files**.
3. Drag `plan.json` in → **Commit changes**.
4. Wait 1–2 minutes, then open the app. (Settings → *Check website for a new plan* forces a check.)

**Option B: paste in the app (quickest)**
1. Copy the JSON from the coach chat.
2. App → ⚙️ Settings → **Paste** → **Check & save**.
3. It is used when its `"updated"` date is newer than the website plan.

Always ask the coach to change the `"updated"` date on every new plan.

## Check-ins

Check-ins are saved on the phone only. Use **Check-in → Copy all for my coach** and paste the text into the coach chat.
Always open the app from the home-screen icon: Safari and the home-screen app keep separate storage.

## Preview on a PC

In this folder run `python -m http.server 8765` and open http://localhost:8765.
