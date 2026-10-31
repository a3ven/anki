# فلش‌کارت (Cloudflare Worker + PWA)

## دیپلوی
1. این پوشه را در یک ریپوی GitHub بگذار.
2. Cloudflare → Workers & Pages → Create → Import a repository → ریپو را انتخاب کن (همان `wrangler.jsonc` استفاده می‌شود).
   - اگر KV خودکار ساخته نشد: `npx wrangler kv namespace create SYNC` و `id` را در `wrangler.jsonc` بگذار.
3. روی ورکر: Settings → Variables and Secrets → یک Secret به نام `APP_KEY` بساز (هر رمز دلخواه).
4. آدرس ورکر را باز کن، در تب «تنظیمات» همان رمز را وارد کن. روی موبایل «Add to Home Screen» بزن.

## نکات
- ترجمه و مثال را Workers AI می‌سازد (بدون کلید جدا).
- آفلاین: کارت‌ها در IndexedDB هستند؛ کلمه‌های اضافه‌شده در حالت آفلاین «در انتظار» می‌مانند و با آنلاین‌شدن ساخته و همگام می‌شوند.
- فاصله‌ها: دوباره ۳۰ دقیقه، سخت ۱ روز، خوب ۳ روز، آسون ۱ سال. میانبر: Space و ۱ تا ۴.
- apkg: از Anki با گزینه Support older Anki versions خروجی بگیر.
