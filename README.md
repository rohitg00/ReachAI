


# ReachAI — AI-Powered & Trend-driven YouTube Metadata 

ReachAI is an AI-powered backend system that helps YouTube creators improve discoverability by generating trend-aware, SEO-optimized metadata for their videos.

The platform automates the full workflow — from fetching channel data to delivering optimized metadata — using an event-driven backend built as a single **iii** worker. A minimal Next.js frontend is used only for job submission, payments, and status visibility.

Creators can purchase a full metadata bundle for 10 videos at ₹99, with results delivered via email.

---

## 💡 Product Overview

ReachAI is designed for creators who want structured, data-driven metadata without spending hours on manual research.  
The system focuses on reliability and clarity by separating each step of the workflow into independent backend events.

---

## 💰 Pricing

| Plan | Details | Price |
|------|--------|-------|
| Free titles | for latest 5 videos two titles for each |  **₹0** |
| Full Metadata Bundle | Titles, descriptions, tags, hashtags & reasoning for **10 videos** | **₹99** |

<br>

- Payments are handled securely using Razorpay.  
- The backend workflow starts only after a verified payment event.



<br>
<br>
<br>



## ⚙️ Tech Stack

### Backend
- iii — worker SDK: functions and topics on the pubsub worker, job state on the state worker, HTTP routes on the http worker, durable retries on the queue worker, all declared in one worker-compose.yaml ([reachai-backend/README.md](reachai-backend/README.md))
- JavaScript (single-file worker)
- Node.js
- YouTube Data API
- AI (LLM for metadata generation)
- Email service (Resend email)
- Razorpay Webhooks

### Frontend
- Next.js  
- Minimal UI for job submission and status updates


<br>
<br>
<br>



## 🧱 Architecture Overview

ReachAI uses an event-driven backend architecture where each step is an independent function in the iii worker, wired together by topics.

**Free flow:** `POST /submit` → resolve-channel → fetch-videos → fetch-niche → fetch-trending → generate-titles → send-titles-email

**Paid flow:** `POST /api/payment/create-order` → Razorpay checkout → verify / webhook → fetch-videos → fetch-niche → fetch-trending → generate-metadata → send-metadata-email

Job state lives in the `state` worker (scopes `reachai-jobs` / `reachai-paidjobs`); the frontend polls `/status` and `/api/payment/paid-jobs/status`. See [reachai-backend/README.md](reachai-backend/README.md) for the full API and the Motia to iii migration notes.





<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>

<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>
<br>

<br>
<br>
<br>





































# Important concepts during building this project. --  my notes.
* state = backend storage → “keep everything safe for later.”

* emit = visible output → “show/send only the important part now.”




* map(callback) callback parameters

When you do:

array.map((item, index) => {})


The callback receives:

item → current element of array

index → position of the item (always starts from 0)





### Why use link instead of li(list) or anchor tag(a). 
> Benefits:

✔ Single-page navigation
✔ No reload
✔ Faster transitions
✔ SEO-friendly
✔ Less layout flash
✔ Works with App Router caching



---

### 💡 Easy Rule of Thumb
> 🔗 Use <Link /> when:

- User clicks to go somewhere

- It’s obvious navigation

- It’s a static path

> 🧭 Use useRouter() when:

- Trigger is caused by JS logic

- You need to redirect after an action

- You don't want the user to click anything

- The path is dynamic or conditional




---

### why key needed in list mainly using .map
> key is a unique identifier React needs to correctly update list items without confusing them.

React uses key to identify each element uniquely inside a .map().

It helps React know which item changed, added, or removed.

Without a unique key, React may mix up items, causing UI glitches.

Using key={EachTab.id} is perfect because IDs are stable and unique.



## typescript doubt-
Example 1: Laptop object
const laptop = {
  brand: "Apple",
  ram: 16,
  SSD: 512
};


typeof laptop → the object shape:

{
  brand: string;
  ram: number;
  SSD: number;
}


keyof typeof laptop → only the keys:

"brand" | "ram" | "SSD"


You can now do:

type LaptopKeys = keyof typeof laptop;

> now after that -
let key: LaptopKeys;

key = "brand"; // ✔ allowed
key = "ram";   // ✔ allowed
key = "SSD";   // ✔ allowed
key = "model"; //not allowed.





## Polling MUST continue (keep trying), unless:

- Job finished (completed)
- Job failed (failed)
- Component unmounted (cleanup)


### Simple Explanation
Mounting → When a component first appears on the screen.

Updating → When the component re-renders because props/state changed.

Unmounting → When the component is removed from the screen.

> Think of it like putting up and taking down a poster:

Mount = you hang the poster.

Update = you change the poster’s content.

Unmount = you take the poster off the wall.


> react HOOk
If a function uses useState, useEffect, or other hooks inside it…
that function MUST be named starting with use



### What does throw error mean in plain JavaScript?
Code after throw does not run

Control jumps to the nearest catch

If there is no catch, the function crashes

That’s pure JavaScript behavior.

### What does throw error mean inside an event handler?
(Written for Motia. Under iii the paid steps keep the same three-attempt
policy through the `paidStep()` wrapper in `src/index.js`, with the counter in
job state instead of a queue.)

In Motia, handler is not just a function —
it’s a job executed by a queue.

So Motia interprets throw error as:

“This event execution FAILED.”

```
Handler throws error
        ↓
Is retry left?
        ↓
YES → wait 60s → retry event
NO  → drop event forever
```








```

//will use this code later--

<tr>
  <td style="padding:20px 8px;">
    <table
      width="100%"
      cellpadding="0"
      cellspacing="0"
      style="
        background:#111;
        border-radius:10px;
        border-collapse:separate;
        border-spacing:0;
        overflow:hidden;
      "
    >
      <tr>
        <td style="padding:30px;text-align:center;">

          <!-- Heading -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td
                style="
                  font-size:20px;
                  font-weight:700;
                  color:#ffffff;
                  padding-bottom:8px;
                  line-height:26px;
                  font-family: Arial, Helvetica, sans-serif;
                "
              >
                You're All Set! <span style="line-height:26px;">🎉</span>
              </td>
            </tr>
          </table>

          <!-- Description -->
          <table width="100%" cellpadding="0" cellspacing="0">
            <tr>
              <td
                style="
                  font-size:14px;
                  color:#d1d5db;
                  line-height:22px;
                  font-family: Arial, Helvetica, sans-serif;
                "
              >
                Use these optimized titles, descriptions, tags, and hashtags to boost your video performance.
                <br><br>
                Want metadata for more videos? Come back anytime!
              </td>
            </tr>
          </table>

        </td>
      </tr>
    </table>
  </td>
</tr>

```


