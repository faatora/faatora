# Faatora — User Guide

## Welcome

Faatora (فاتورة) is an e-invoicing platform built for Omani businesses that need to issue tax invoices in the format the Oman Tax Authority will require under the Fawtara mandate. It is run by Modern Venture Shelter LLC in Muscat. Two kinds of people use it: accounting firms that keep the books for many small clients and want to prepare them for the mandate from a single console, and shop owners at those clients who log in to issue invoices, run a till, or check what has been reported. This guide covers both. Part 1 is for accountants, Part 2 for shop owners, Parts 3 through 5 apply to everyone. Read the part that matches your role, and come back for compliance and troubleshooting when you need them.

## Part 1 — For Accountants

### 1.1 What Faatora does for your firm

Faatora gives your firm one login, one dashboard, and one subscription that covers every client you manage. Each client lives in a separate tenant with its own data and OTA submissions, but you move between them from a header dropdown. Staff see only the clients you assign them. Partners see the whole firm. You can import a client's existing books from Tally Prime or Zoho Books, issue invoices on their behalf, submit them to OTA through our accredited Access Service Provider, and export quarterly VAT return totals that drop straight into your return workpaper. Nothing we built forces you to change how you work with Tally. A client can keep Tally for management accounts and only use Faatora for the e-invoice leg.

### 1.2 Creating your firm account

Go to app.faatora.om and click the white "Create firm account" button at the top right. A single form with seven fields appears. Fill it in as follows.

| Field | What to enter | Example |
| --- | --- | --- |
| Firm trade name | The name you use with clients, in English | Al Mansouri & Partners |
| Legal name | The name on your commercial registration | Al Mansouri Chartered Accountants LLC |
| CR number | Your seven digit commercial registration number | 1234567 |
| VATIN | Your fifteen digit VAT identification number issued by OTA, which starts with OM | OM300123456789 |
| Primary contact email | The inbox that will receive billing and system notifications | partners@almansouri.om |
| Phone | Your office number in international format | +968 2456 7890 |
| Oman city | The city your office operates from | Muscat |

Agree to the terms of service and click the blue "Create firm" button at the foot of the form. We send a six digit verification code to the contact email. Enter the code on the next screen. Your firm is created, you are set as the owner, and you land on an empty dashboard with a banner that says "Invite your team to get started."

If the email never arrives, check that your mail server is not blocking faatora.om. The code is valid for ten minutes. Click "Resend code" to request a fresh one.

### 1.3 Inviting your team

Open the Members page from the left sidebar. You see your own row and a blue "Invite member" button at the top right. Click it.

Faatora uses four roles. Pick carefully: the role controls what the person can see and change across every client.

| Role | Can do | Cannot do |
| --- | --- | --- |
| Owner | Everything, including closing the firm and changing billing | Nothing restricted |
| Partner | Add and remove clients, invite team, approve VAT exports, enter any client | Close the firm or change the billing plan |
| Staff | Work inside assigned clients: issue and submit invoices, run imports | See unassigned clients, invite team, change billing |
| Read only | View everything in the firm and assigned clients | Create, edit, submit, or delete |

Enter the person's email, pick a role, and tick the clients they will work on. For a partner, you can leave the list empty and they will see every client. For staff, pick at least one. Click "Send invitation." The person receives an email titled "You have been invited to Al Mansouri & Partners on Faatora." They set a password and confirm a mobile number for two factor sign in, and on first login they land on the firm dashboard with only their assigned clients visible.

If a team member leaves your firm, open their row on the Members page and click "Revoke access." Their session ends within five minutes and any open invoice closes without saving.

### 1.4 Onboarding your first client

From the firm dashboard, click the green "Add client" button at the top right. A two step form opens.

Step one asks for the client's business details.

| Field | What to enter | Example |
| --- | --- | --- |
| Trade name | How the shop is known to customers | Bait Al Khair Textiles |
| Legal name | Name on the client's CR | Bait Al Khair Textiles LLC |
| CR number | Seven digit commercial registration | 1089654 |
| VATIN | The client's fifteen digit OM VAT number | OM300987654321 |
| Business type | Retail, wholesale, services, manufacturing, mixed | Retail |
| Default VAT rate | 0%, 5%, or exempt | 5% |
| Base currency | Default OMR | OMR |

Step two asks for the primary shop owner contact, the person who will log in to the tenant.

| Field | Example |
| --- | --- |
| Full name | Mohammed Al Harthy |
| Email | mohammed@bait-alkhair.om |
| Mobile | +968 9123 4567 |

Click "Create client." Faatora provisions the client tenant, enrolls them under your firm, and emails the shop owner an invitation titled "Al Mansouri & Partners has added you to Faatora." The email contains a magic link valid for seven days. Mohammed clicks it, sets a password, agrees to the shop owner terms, and lands on his own invoice list. He sees only Bait Al Khair. He does not see your other clients or your firm dashboard.

### 1.5 Bulk client onboarding

If you are bringing twenty or more clients across at once, use bulk onboarding. Click "Add client" and switch the toggle at the top of the modal to "Bulk from CSV."

Prepare a CSV with these columns in this order. The header row is required.

```
trade_name,legal_name,cr_number,vatin,business_type,default_vat_rate,owner_name,owner_email,owner_mobile
```

The maximum is fifty rows per upload. If you have more than fifty, split them into separate files.

Drag the CSV into the dotted upload area or click to browse. Faatora parses the file and shows a preview table with a status column. Each row is marked ready, warning, or error.

- Ready rows have all required fields and no duplicates. They will be created on commit.
- Warning rows will be created but have something worth checking, such as an owner mobile missing the +968 prefix. Faatora normalises these but flags them.
- Error rows will not be created. Common causes are a VATIN already in Faatora under a different firm, a VATIN that fails the OTA checksum, or a missing owner email. Each error row shows a reason in red.

Fix the errors in your CSV and reupload, or click "Commit ready rows only" to proceed with the valid rows. Faatora creates each tenant, enrolls it under your firm, and queues invitation emails. A toast confirms how many clients were created.

For an unclear error, open Members, click your own row, scroll to the audit log, and look for the most recent `bulk_import.failed` event. The payload has the raw validation message.

### 1.6 Importing a client's existing books

Most new clients already have invoices in another system. Faatora imports from four sources today. In every case, the flow is the same: export from the source, upload to Faatora, map columns, preview, commit. Switch into the client tenant first (see section 1.9), then open Imports from the left sidebar.

**Tally Prime Day Book CSV**

In Tally Prime, go to Display More Reports, then Day Book. Set the period. Press Alt+E, pick CSV, and save. Upload to Faatora. The importer auto detects Tally Day Book and maps the columns. Confirm the date range and the default sales ledger, then click Preview. Faatora shows the first fifty parsed invoices with their lines. Click "Commit all" to import.

**Tally Sales Register CSV**

Go to Display More Reports, Account Books, Sales Register. Set the period, press Alt+E, pick CSV, and save. Upload to Faatora. The Sales Register carries more structured line level data than the Day Book, so the preview is richer.

**Tally Prime XML export**

For older Tally Prime versions that produce structured XML, use Gateway of Tally, Display, Statements of Accounts, Tally XML. Faatora reads the XML directly. This gives the cleanest import, because the schema includes tax ledgers often buried in the CSVs.

**Zoho Books invoices CSV**

In Zoho Books, open Invoices, click the three dot menu at the top right, choose Export, and pick "All invoices" with a date range. Save the CSV. Upload to Faatora. The importer recognises the Zoho column names.

**Mapping columns**

If your export uses non standard column names, Faatora shows a mapping screen. Each required Faatora field (invoice number, date, customer name, customer VATIN, line description, quantity, unit price, tax rate, tax amount, total) has a dropdown of CSV columns. Pick the match and click "Save mapping." Faatora remembers the mapping per client, so the second import is one click.

**Preview and commit**

Review the preview. Sort by amount. Look for rows where the total does not equal unit price times quantity plus VAT. Faatora flags these in orange. Edit a row inline, skip it, or commit anyway.

**Handling errors**

Common errors and fixes:

- "Customer VATIN fails checksum." Typo in the source. Edit the cell or fix the CSV and reupload.
- "Duplicate invoice number." Already exists in Faatora. For a real re import, check "Skip duplicates" above the preview.
- "Date out of range." The row is outside the range you set. Widen the range or exclude the row.
- "Line items missing." Usually a line item mapping error. Go back a step and remap.

**Re importing without duplicates**

Every imported invoice carries a source reference combining source system and original invoice number. Upload the same file twice and Faatora skips the matches by default. The "Force import" toggle overrides this, but use it only to replay a deleted batch.

### 1.7 The firm dashboard

The firm dashboard is your home screen: five tiles across the top, three panels below.

**Top tiles**

| Tile | What it shows |
| --- | --- |
| Clients | Active clients, split into onboarding, live, paused |
| Invoices this month | Count submitted to OTA this month across all clients |
| Clearance rate | Share of submissions in the last 30 days OTA accepted first try |
| Pending issues | Invoices needing accountant attention (validation failures, OTA rejections) |
| Next VAT return due | Nearest return deadline across your client base, with days remaining |

**Per client breakdown**

A table below the tiles shows one row per client: trade name, VATIN, invoices this month, clearance rate, issues count, next return due. Click any row to drop into that tenant.

**Issues panel**

The right hand panel lists every open issue across all clients, sorted by severity. Each entry has the client name, the issue type, and an "Open" button that jumps straight to the affected invoice. Typical entries: "OTA rejected: buyer VATIN not recognised" or "Validation: credit note references a non existing invoice."

**Upcoming VAT returns**

The bottom panel lists the next six VAT return deadlines by client, with the tax period and filing deadline. Click a row to see the draft return summary.

### 1.8 Batch operations

Two bulk actions save real time when you are closing out a period.

**Validate all pending invoices**

Open any client, go to Invoices, filter by "Draft" or "Pending validation", and click the gray "Validate all" button above the table. Faatora runs every row through the PINT-OM schema checks and OTA business rules. Each row gets a result and you can submit the valid ones in one click.

Partners can run this firm wide from "Batch actions" on the firm dashboard. A progress bar appears.

**Export VAT return summary CSV**

Open a client, go to Reports, and click "VAT return summary." Pick the tax period (quarterly by default) and click "Export CSV." The file has one row per VAT box with the OMR amount. Copy figures from here into the OTA return portal.

Partners can export firm wide from "Batch actions" on the firm dashboard. Pick the period and the clients to include. You get one CSV with one row per client per VAT box.

### 1.9 Acting on a specific client

To work inside a client tenant, open the header dropdown that shows your firm name at the top left. A search box and your accessible client list appear. Type the trade name or VATIN and pick the client. The interface switches context: the header shows the client name and every menu item is scoped to that client.

What you can do inside a client depends on your firm role and any client restrictions the owner has set.

| Firm role | Inside a client tenant you can |
| --- | --- |
| Owner | Everything the shop owner can do, plus delete the tenant |
| Partner | Everything the shop owner can do except change the subscription; you can impersonate for troubleshooting |
| Staff | Create, edit, validate, submit invoices, run imports, export reports |
| Read only | View everything and download reports; no create or edit |

A shop owner can also invite their own users directly inside their tenant. Those users do not count against your firm seats and are not visible on your Members page.

To leave a client, click the firm name in the header dropdown and pick "Back to firm dashboard."

### 1.10 Billing and subscriptions

Your firm is billed per seat per year. A seat is any active firm member, regardless of role. Read only seats cost the same as staff seats. Shop owner users at your clients are included at no extra cost. Pay in OMR by card through Stripe, or by local card or bank transfer through Paymob.

Open Settings from the sidebar, then Billing. You see your current plan, seat count, and next invoice date.

**Adding seats.** Click "Add seats" and pick a quantity. New seats are prorated against the remainder of your annual term and charged immediately. Invite the new members as soon as the charge clears.

**Removing seats.** Revoke the member's access on the Members page first. Then come back to Billing and click "Remove seats." You can only remove down to the active member count. Removed seats are credited against your next renewal. We do not refund mid term.

**Managing payment method.** Click "Update payment method." You can switch between Stripe and Paymob without cancelling. The next invoice uses the new method. If a card fails, we retry three times across seven days before suspending. During suspension, members can view everything but cannot submit new invoices.

## Part 2 — For Shop Owners

### 2.1 Receiving an invitation from your accountant

Your accountant has added your business to their firm on Faatora. You receive an email titled "Al Mansouri & Partners has added you to Faatora." The body names your accountant and your business and has a blue "Accept and set up account" button.

Click it. You land on a page asking you to pick a password and confirm your mobile number. Pick a password with at least ten characters, one number, and one symbol. Enter the six digit SMS code we send. Tick the box to agree to the shop owner terms.

You land on your invoice list. It is empty for a fresh tenant, or shows invoices your accountant imported from Tally or Zoho. The sidebar has Invoices, Credit notes, Customers, Reports, POS, and Settings. The top right shows your name with a Sign out dropdown.

Your accountant works alongside you. They see what you see, can create and edit on your behalf, and can answer questions in context. You do not need to forward anything.

### 2.2 Your invoice workflow

**Creating a tax invoice**

From the invoice list, click the blue "New invoice" button at the top right. Pick a customer or create one inline. A customer needs a name, a country, and for Omani VAT registered customers, a VATIN. For B2C customers, skip the VATIN and switch the invoice type to "Simplified."

Fill in the header. Date is prefilled to today. Due date is thirty days out. Reference is optional but useful if your customer tracks purchase orders.

Add lines. Each line has a description, quantity, unit price, and VAT treatment. VAT is auto calculated at your default rate (usually 5%). For zero rated items, pick 0%. For exempt items, pick Exempt. For reverse charge, pick Reverse charge and the invoice shows the right wording.

The right rail shows subtotal, VAT, and total updating as you type. All amounts are in OMR to three decimals (the baiza).

Then click one of three buttons at the foot of the page.

- "Save draft" keeps the invoice in draft. It is not sent to OTA.
- "Validate" runs the PINT-OM checks and OTA business rules. Failures appear as red flags next to the offending fields.
- "Submit to OTA" validates and submits. The invoice gets a clearance identifier within seconds and the state changes to Cleared. Download the PDF, which shows the QR code OTA requires.

**Credit notes and debit notes**

Open the original invoice. Click the three dot menu and pick "Create credit note" or "Create debit note." Faatora prefills the lines with negative amounts (for a credit) or additional amounts (for a debit). Edit as needed and submit the same way. The link to the original is carried through so OTA can match them.

**Recurring invoices**

Open Customers, pick the customer, click "Set up recurring." Pick a frequency (weekly, monthly, quarterly), a start date, an end date or "no end", and a template invoice. Faatora generates the invoice on schedule and leaves it in draft for your review. You still validate and submit each occurrence. We do not auto submit, because something usually needs checking.

**Simplified B2C receipts**

For retail sales to individuals, use the "Simplified" invoice type, or use the POS which issues these automatically. A simplified receipt has fewer required fields than a tax invoice but still carries the mandatory QR code. Email it to the customer or print it on a receipt printer.

### 2.3 Using the POS (for retail shops)

The POS is a Progressive Web App that runs in your browser and installs like an app on your phone, tablet, or shop computer.

**Setting up the POS on your device**

Open pos.faatora.om on the device you will use at the counter. Sign in with your main app credentials. On first sign in you are prompted to install the POS. On Chrome and Edge, click "Install." On Safari on iOS, use Share then "Add to Home Screen." The POS icon appears on your home screen and launches full screen.

**Taking a sale**

Tap to add items from your product catalog, or enter a one off line. The ticket updates on the right. When the customer is ready, tap "Charge." Pick a payment method (cash, card, bank transfer). For card, type in the amount captured by your terminal. For cash, enter the tendered amount and the POS shows the change. Tap "Complete sale." The POS issues a simplified receipt with the QR code and offers to print or email it.

**Offline mode**

Internet drops happen. The POS keeps working. If you lose connection, a yellow banner says "Offline. Sales will sync when you are back online." Keep taking sales exactly the same way. Each sale sits in a local queue on the device. The customer receipt has a provisional flag until it syncs but is still valid.

When the connection returns, the banner turns green and reads "Syncing." Each queued sale is sent to Faatora, submitted to OTA, and marked cleared. If OTA rejects any sale (rare, usually a bad buyer VATIN), the banner surfaces the error and the sale appears in your Issues panel.

Keep the device charged during long offline stretches. Sync is automatic on reconnect, and the queue persists across reboots if the battery dies first.

**End of day summary**

Tap the menu icon at the top left, then "End of day." The POS shows the day's sales total, the split by payment method, the count of simplified receipts, and any sale still waiting to sync. Review it, tap "Close day," and the POS resets for tomorrow.

### 2.4 Checking submission status

Every invoice has a status chip. The chips are Draft, Pending, Submitted, Cleared, Rejected.

- Draft: not submitted yet.
- Pending: validation or submission in progress.
- Submitted: handed to the OTA Access Service Provider.
- Cleared: OTA accepted it and returned a clearance identifier.
- Rejected: OTA refused it. Reason appears in red below the chip.

If an invoice is rejected, open it and read the reason. Common causes: a buyer VATIN not active in OTA's registry, a date outside the tax period, or a mismatch between declared and calculated VAT. Fix the cause and click "Resubmit." You do not need a new invoice number.

### 2.5 Getting your VAT return numbers

Open Reports from the sidebar and click "VAT return summary." Pick the quarter. A one page summary appears with the standard OTA return boxes: standard rated sales (output VAT at 5%), zero rated sales, exempt sales, standard rated purchases (input VAT at 5%), imports subject to reverse charge, and net VAT payable or refundable.

Click "Export CSV" to download the figures. Email the file to your accountant. If your accountant is on your firm, they already see it in their own dashboard and need nothing forwarded.

### 2.6 Settings

Open Settings from the sidebar. Four tabs cover what a shop owner needs.

**Business info.** Your CR, VATIN, trade name, legal name, and contact details. Your accountant filled most of this in. Keep the logo up to date, since it appears on every invoice PDF and POS receipt.

**Default VAT rate.** The rate used for new lines. For most shops this is 5%. Food retailers with a mix of exempt and standard rated items should keep 5% and change per line.

**User management.** Invite other people from your shop. These users are separate from your accountant's firm team and only see your tenant. Roles: Manager (full tenant access) and Cashier (POS only).

**Account preferences.** Language (English or Arabic), date format, and notification channels (email, SMS, or both).

## Part 3 — Compliance reference

### 3.1 The OTA Fawtara mandate

Fawtara is the Oman Tax Authority's electronic invoicing programme. It requires VAT registered businesses to issue invoices in a structured electronic format and to clear them with OTA through an accredited Access Service Provider before they are legally valid.

- Phase 1 ran a pilot with selected large taxpayers.
- Phase 2 is bringing the remaining large taxpayers onto the system now.
- Phase 3, expected to go live in late 2027 per Resolution 189/2026, extends the mandate to every VAT registered SME in Oman.

If you are in scope and not issuing cleared invoices when your phase goes live, your invoices are not legally valid for VAT purposes. You cannot reclaim input VAT against them, and OTA can penalise both issuer and buyer. Start onboarding well before your phase date.

### 3.2 What a compliant invoice must contain

Every tax invoice must carry the following fields.

- Invoice number, unique within your series
- Issue date, and supply date if different
- Supplier legal name, CR, VATIN, and address
- Buyer name, CR, VATIN, and address (VATIN only if the buyer is VAT registered)
- Each line: description, quantity, unit, unit price, VAT treatment and rate
- Subtotal before VAT, VAT amount, and total
- Currency (OMR for domestic trade)
- Reference to the related invoice, for credit and debit notes

For B2C simplified invoices, buyer details are not required, but a QR code is. The QR code encodes the supplier VATIN, issue timestamp, total, VAT amount, and the hash of the invoice payload. An OTA inspector can scan it with their phone to verify on the spot.

Omani invoices should be bilingual. Arabic is required, English permitted alongside. Faatora renders both side by side on the PDF and POS receipt by default, and switches to Arabic only or English only on request.

### 3.3 PINT-OM (UBL 2.1) brief explainer

PINT is the Peppol International Invoice standard. PINT-OM is Oman's country specification of PINT. Under the hood, a PINT-OM invoice is a UBL 2.1 XML document with Omani extensions for the VATIN format and Arabic language markers.

When we say "your invoice is PINT-OM compliant," we mean the XML we submit conforms to the schema OTA requires, carries the right country extensions, and will pass OTA validation on first try barring a data problem. You do not need to know UBL or open the XML. If OTA asks for the raw file during an audit, we can produce the signed XML and clearance response for any invoice up to ten years old.

### 3.4 Archive and retention

Omani VAT law requires invoice records be kept for ten years from the end of the tax period. Faatora keeps every cleared invoice, rejection, resubmission, and PDF for the full term.

Every invoice sits in a tamper evident archive. Each new invoice includes a cryptographic hash of the previous record, so any change to history breaks the chain. An archive integrity report is available from Reports for auditor verification.

### 3.5 Who the ASP is and why it matters

OTA does not accept invoices directly. The Peppol model used for Fawtara has five corners: supplier, supplier's Access Service Provider (ASP), buyer's ASP, buyer, and tax authority. ASPs are accredited intermediaries that carry invoices and report them to OTA.

Faatora is accredited as an ASP in Oman, or integrates with an accredited ASP on your behalf. You do not need to pick an ASP or sign a separate contract. When you click "Submit to OTA," we route the invoice through the network and bring back the clearance identifier.

## Part 4 — Troubleshooting

### 4.1 I cannot log in

If you have forgotten your password, click "Forgot password" on the sign in page. We send a reset link within a minute, valid for one hour.

If the reset email does not arrive, check your spam folder. If it is not there, check that your email domain is not blocking faatora.om. If you have never completed first login, ask your accountant to resend the invitation.

If sign in says "two factor code is invalid" and you no longer have the mobile number on file, email support with your business name, VATIN, and CR. We verify your identity before resetting the factor.

### 4.2 My invitation link expired

Invitation emails are valid for seven days. Ask your accountant to resend from their Members page. The new link replaces the old one.

### 4.3 An invoice was rejected by OTA

Open the invoice. The rejection reason appears in red under the status chip. Common causes:

- Buyer VATIN not found in the OTA registry. Confirm the VATIN with your customer.
- VAT amount does not reconcile. Each line's VAT must equal the line amount times the rate rounded to three decimals, and the sum must match the header.
- Supply date more than 180 days before the issue date. OTA rejects very old backdated invoices. Issue a current date and reference the earlier delivery.
- Duplicate invoice number. Pick the next number in your series.

Fix the cause and click "Resubmit." No new invoice number needed.

### 4.4 The CSV import skipped some rows

Faatora skips rows on validation failure rather than blocking the batch. Open the import job from Imports and scroll to "Skipped rows." Common reasons: duplicate source reference, unparseable date, missing line items. Fix the file and reupload with "Skip duplicates" on to catch only the previously skipped rows.

### 4.5 The POS is showing stale data or "Offline"

If the POS banner says Offline and other devices are online, the issue is on the POS device. Check Wi Fi. Try loading app.faatora.om in another tab on the same device. If the main app loads but the POS still says Offline, pull down to refresh. If it persists, sign out and sign in again. Queued sales are preserved across sign out.

For stale product prices after a catalog update, pull to refresh. The POS syncs its catalog every five minutes in the background, but a manual refresh is immediate.

### 4.6 I need to switch my accounting firm

Tenants can transfer between firms. Email support with your current firm name, your new firm name, and your VATIN. We confirm the transfer with both firms' owners in writing before the switch. All invoices, customers, and history are preserved.

### 4.7 Where my data is hosted and security basics

Data is hosted in a data centre inside the Sultanate of Oman, in line with Oman's Personal Data Protection Law (PDPL). We encrypt data at rest with AES-256 and in transit with TLS 1.3. Every member has two factor sign in enforced by default. Audit logs capture every create, edit, submit, and delete event with the actor, client tenant, and timestamp, and are retained for the full ten year statutory period.

Our full security posture is at faatora.om/security.

### 4.8 How to export all my data

Open Settings, Data export. Click "Request export." We produce a ZIP with invoices as PDFs, invoices as UBL XML, customers as CSV, products as CSV, and signed OTA clearance responses. The archive is ready within minutes for small tenants and up to an hour for large ones. We email you when it is ready. The download link is valid for seven days.

If you are leaving Faatora, run the export before you cancel. Once a tenant is closed, we retain the data for the statutory ten years but self service download is no longer available, and you have to request an export through support.

## Part 5 — FAQ

**How much does Faatora cost?**
Firms are billed per seat per year. Current pricing is on faatora.om/pricing. Shop owner seats at managed clients are included. No setup fee.

**Can I cancel at any time?**
Yes. Firms can cancel from Settings, Billing. Shop owners under a firm should ask their accountant to end the tenant. Access runs to the end of your paid term. Data is retained for the statutory ten years regardless.

**Can I take my data with me?**
Yes. Use the export flow in section 4.8. UBL XML for invoices, CSV for customers and products, PDF for the human readable invoices.

**I work for two accounting firms. Can one email be in both?**
Yes. One email can belong to multiple firms. The header dropdown lists every firm you belong to.

**Is the interface available in Arabic?**
Arabic with right to left layout is scheduled for Wave 3. Invoices and receipts are already bilingual at the document level. The admin UI is English only for now.

**Is Faatora compliant with Oman's PDPL?**
Yes. Data is hosted inside Oman. We publish a data processing addendum on request. We never send personal data outside Oman without a legal basis and signed instruction.

**What happens if Faatora goes down?**
Uptime is at status.faatora.om. The POS keeps running offline when the main service is unreachable. Submitted invoices queue and send when we are back. Extended downtime is documented through the ASP exchange, which OTA accepts in audit.

**Can I use Faatora without an accountant?**
Yes. Sign up directly at app.faatora.om. You pay the single tenant subscription instead of being included in a firm's seat count.

**Do you integrate with my bank for reconciliation?**
Bank reconciliation is a 2027 roadmap item. Today you can export invoices and reconcile in your existing tooling.

**What accredited ASP does Faatora use?**
We operate as an accredited ASP in Oman with fallback relationships to other accredited ASPs. Details at faatora.om/compliance.

**Can I bulk cancel invoices?**
No. Omani VAT law requires a credit note to reverse a cleared invoice. Issue a credit note against each one.

**What if OTA changes the schema?**
We track the PINT-OM specification and apply updates centrally. We email the firm primary contact before any customer facing change.

**Do you offer onboarding support for a firm with 50+ clients?**
Yes. Email support with your firm name and expected client count. We assign an onboarding engineer who helps prepare the bulk CSV, maps your Tally or Zoho columns once for reuse, and runs a dry import against a sandbox.

**How do I know my hash chain is intact?**
Open Reports, Archive integrity. The report shows the first and last invoice in the chain, the hash at each boundary, and a green badge if intact. If anything is wrong, the badge turns red and names the first broken record.

## Appendix A — Keyboard shortcuts

These shortcuts work on the main web app. The POS is designed for touch and does not have keyboard shortcuts.

| Shortcut | Action |
| --- | --- |
| g then d | Go to dashboard |
| g then i | Go to invoices |
| g then c | Go to customers |
| g then r | Go to reports |
| n then i | New invoice |
| n then c | New credit note |
| / | Focus search |
| ? | Show the shortcut help panel |
| cmd/ctrl + s | Save the current draft |
| cmd/ctrl + enter | Submit the current invoice |
| esc | Close any open modal |

### Appendix B — Glossary

- **Fawtara**: The Oman Tax Authority's electronic invoicing programme.
- **Faatora**: This product. The Arabic word for invoice.
- **ASP**: Access Service Provider. An accredited intermediary that routes invoices to OTA in the Peppol model.
- **Peppol**: The international network of ASPs that exchange structured business documents. Oman adopted Peppol for Fawtara.
- **PINT-OM**: The Oman country specification of PINT, the Peppol International Invoice standard.
- **UBL**: Universal Business Language. The XML format PINT is built on.
- **VATIN**: VAT Identification Number. In Oman, fifteen digits starting with OM.
- **CR**: Commercial Registration number. The seven digit number issued when a business is incorporated.
- **PDPL**: Oman's Personal Data Protection Law.
- **Simplified invoice**: A B2C invoice with reduced buyer detail requirements but a mandatory QR code.
- **Credit note**: A document that reverses or partially reverses a prior invoice.
- **Debit note**: A document that increases the amount of a prior invoice.
- **Reverse charge**: A VAT treatment where the buyer accounts for VAT instead of the seller. Common on imports.
- **Firm**: An accounting firm account on Faatora. Contains members and manages clients.
- **Tenant**: A client's own data space inside Faatora. One SME equals one tenant.

### Appendix C — Support and contact

Our support team is based in Muscat.

- Email: support@faatora.om
- Phone: +968 2200 0000
- Support hours: Sunday to Thursday, 08:00 to 17:00 Oman time (GST, UTC+4)
- Status page: status.faatora.om
- Security disclosures: security@faatora.om

For urgent production issues outside support hours, email support with "URGENT" in the subject. We monitor the queue around the clock for critical outages.
