# Memory map v43 (kod nomi: Xotira)

Xotira shifrlangan mahalliy omborda Markdown qaydlar, biriktirmalar, vazifalar va bog‘lanishlarni saqlaydi. Qaydlarni muharrir, jadval, Kanban, galereya, taqvim yoki xaritada oching.

## Public downloads

Visit [Memory map](https://memory-map-ecru.vercel.app/) or [GitHub Releases](https://github.com/N-Muhammadjonov/memory-map/releases) for verified platform assets. Download the `.dmg` for macOS (Apple Silicon or Intel) and drag Memory Map to Applications; Windows x64 uses `.exe`, Android uses `.apk`, and Linux x64/ARM64 use `.tar.gz`.

V43 opens in its own application window on macOS, Windows, Linux and Android. Google sign-in and external website links may open the system browser; your notes remain in the app. Windows requires the Microsoft WebView2 Runtime. The encrypted vault remains on the user's device. The optional Account menu uses a separate identity provider and does not upload local notes. Updates can be enabled from the Updates menu. A downloaded binary is checked against the official release SHA-256 digest before it opens on the next launch.

## Mac’da ishga tushirish (source archive)

ZIP Downloads ichida ochilgan bo‘lsa, Terminalda quyidagi to‘liq yo‘l bilan ishga tushiring.

```sh
sh "$HOME/Downloads/memory-map-v43/start.command"
```

ZIP boshqa joyda ochilgan bo‘lsa, Terminalga sh va bitta bo‘sh joy yozing, Finder’dan start.command faylini Terminalga sudrab tashlang va Enter bosing.

Python 3.10 yoki yangirog‘i kerak. Birinchi ishga tushirishda skript `.venv` yaratadi va kerakli paketlarni o‘rnatadi. Mahalliy agent uchun portni belgilang. `--no-browser` terminal rejimi va `--browser` ixtiyoriy brauzer rejimi saqlangan.

```sh
sh start.command --port 4720
```

Mac’dagi odatiy ombor manzili `~/Library/Application Support/Xotira/Xotira.xotira`. Boshqa omborni ochish uchun `--vault /mutlaq/yo‘l/ombor.xotira` parametridan foydalaning. v13 ombori birinchi muvaffaqiyatli ochilganda, sxema kengayishidan oldin yonida shifrlangan zaxira yaratiladi.

## v36 tuzatishlari

- Rasm, PDF, hujjat va mind map tabida X tugmasi bor. Fayl ochilgan holda boshqa ekranga o‘tsangiz ham o‘sha tabni yopa olasiz. Belgilar va xarita tahrirlari yopishdan oldin saqlanadi.
- Dark, Slate va Paper mavzulari uchun matn, havola, jadval, tugma, kod sintaksisi, holat va graf ranglari moslashtirildi.
- Kod blokiga alohida X tugmasi qo‘shilmadi.

## v35 tuzatishlari

- Shoxni bir marta bosing. To‘liq sarlavha va tavsif shu katak ichida ko‘rinadi. Ikki marta bosish sarlavhani tahrirlaydi.
- Yangi qaydning bo‘sh yozish qatorida miltillovchi kursor ko‘rinadi.
- Trash’dagi qayd nomini yangi qaydga berish mumkin. Nomi band bo‘lib qolgan qayd tiklansa, masalan, `Ha (2)` nomi bilan qaytadi.
- Qayd matnida `=>`, `->`, `<->`, `!=`, `(c)`, `1/2` yoki `...` kabi qisqartmalardan so‘ng Enter yoki Space bosing. Ular `⇒`, `→`, `↔`, `≠`, `©`, `½` va `…` belgilariga aylanadi.

## v34 tuzatishlari

- Yangi qayd ochilganda kursor birinchi yozish qatoriga tushadi.
- Mind map shoxi ustiga ikki marta bosing yoki `F2` tugmasini bosing va nomni xaritaning o‘zida yozing. Rangni yuqori paneldagi «Topic color» orqali o‘zgartiring. Uzun matnli to‘rtburchakni bir marta bosish matnni to‘liq ko‘rsatadi.
- Mind map, kod, jadval va boshqa maxsus bloklar ostidagi oddiy qatorga yozish mumkin. Koddan chiqish uchun `Shift+Enter` yoki macOS’da `⌘+Enter` tugmalarini bosing.

## v33 AI readiness

The offline AI assistant is available in developer mode. It previews the exact request, can stream Mock responses, and stages changes as proposals. AI is off by default. Read [CONNECT_AI.md](docs/CONNECT_AI.md) for the local demo and the steps for a future direct provider integration.

## v32 yangiliklari

- Rasm, PDF, hujjat yoki matn faylini oching va «Ustiga yozish» tugmasini bosing. Qalam, marker, matn va o‘chirg‘ich bor. Belgilarni saqlasangiz, ular ombor ichida fayl yoki sahifa bilan birga ochiladi. «Download» asl faylni yuklaydi.
- Word ko‘rinishi sarlavha, jadval va qo‘llab-quvvatlanadigan ichki rasmlarni chiqaradi. Excel va PowerPoint hamda ODT, ODS va ODP uchun ichki ko‘rinish bor. Brauzer ocholmaydigan formatlarda asl faylni yuklab, o‘z dasturida oching.
- Kod bloki tilni aniqlaydi va `Run` tugmasini faqat mahalliy runner tekshiruvidan o‘tgan kodga chiqaradi. SQLite alohida vaqtinchalik bazada ishlaydi. Cheklangan Python runner macOS va Linux’da mavjud. Natija blok ostida chiqadi. Blokdan X tugmasi olib tashlandi.

## v31 yangiliklari

Quyida V31 dagi holat keltiriladi. V33 da AI kalitlari alohida shifrlangan faylga ko‘chirildi. Haqiqiy provayderlar uzilgan.

- Home’dagi yo‘riqnoma qayd yaratish, wiki havolalari, slash menyusi va 3D grafni ko‘rsatadi. GitHub buildlari o‘z repozitoriysidagi so‘nggi barqaror relizni tekshiradi. Lokal manba kodi uchun `XOTIRA_GITHUB_REPO=egasi/repozitoriy` orqali reliz repozitoriysini belgilang.
- Database’da qaydlarni guruhlang va filtrlab, ko‘rinishni omborga saqlang. Grafda bog‘lanmagan qaydlarni ko‘ring. Tavsiyalar umumiy teg va atamalarga asoslanadi.
- Fikr yuborishda 1 MB gacha bo‘lgan PNG, JPEG yoki WebP skrinshot tanlash va yuborishdan oldin ko‘rish mumkin. Mavjud fikr serveriga [D1 yangilanishi](stats-worker/README.md#feedback-screenshots) kerak.
- Obsidian va Notion ZIP importlari saqlangan. Markdown aks ettirish tanlangan joyda ochiq Markdown fayllar yaratadi, tashqaridan tahrirlangan fayllarni saqlaydi va parol qo‘yilgan qaydlarni chiqarib tashlaydi. Eski aks ettirish fayllaridan dastur egaligi tasdiqlay olmaganlarini siz boshqarasiz.
- Ombor paroli uchun bir martalik tiklash kaliti mavjud. Alohida qayd paroli ilova ichidagi kirishni cheklaydi. Fayl darajasidagi shifrlash ombor paroliga bog‘liq. Home oxirgi muvaffaqiyatli zaxira 14 kundan eski bo‘lsa eslatadi.
- AI provayderlari menyusida OpenAI, Claude, Gemini, Grok, Groq, Qwen, DeepSeek va Mistral kalitlarini shifrlangan omborga saqlash mumkin. Qwen uchun ish maydoni ID raqami va hududni ham kiriting. «Ulanishni tekshirish» model katalogini oladi. Qaydlar yuborilmaydi va AI yordamchi yoqilmagan.

## v30 yangiliklari

- **Qator boshidan yozish va belgilash tuzatildi.** Sabab: bloklar chetidagi «+ ⠿» paneli matn boshidan 2 px ichkarigacha cho‘zilgan edi. Qator boshidan bir oz chapdan bosganda (yoki sichqonchani bosib sudrashni boshlaganda) bosish matnga emas, panelga tushar, fokus tahrirlovchidan chiqib ketar (kursor yo‘qolardi) va belgilash ishlamasdi. Endi panel matn ustini yopmaydi, tahrirlanadigan hudud matndan 12 px chetga kengaytirilgan, yuqori chetda bosish ham kursorni birinchi qatorga qo‘yadi.
- **English spell check:** yuqori paneldagi til tanlagich yonida «Spell» tugmasi (tor ekranda «···» menyusida). Yoqilsa, tahrirlovchi, sarlavha va manba maydonida inglizcha imlo xatolari brauzer tomonidan chiziladi; o‘ng tugma bilan tuzatish takliflari chiqadi. Tanlov eslab qolinadi.
- Yangi brauzer testi: `tests/browser/editor_input_v30.py`.

## v29 yangiliklari

- **`</>` tugmasi endi haqiqiy kod bloki yaratadi.** Matnni belgilab `</>` bossangiz, tanlangan matn (bir yoki bir necha abzas) Notion kabi kod blokiga aylanadi (til avtomatik aniqlanadi, Run/nusxa/yuklab olish tugmalari bilan); belgilangan qismdan oldingi va keyingi matn oddiy abzas bo‘lib qoladi. Oddiy qator ichidagi kod uchun alohida «`» tugmasi va ⌘E qoldi. Ro‘yxat, jadval yoki mavjud kod ichida belgilangan bo‘lsa, eski xatti-harakat (inline kod) saqlanadi.

## v28 yangiliklari

- **Nom:** ilova endi «Memory map» (ichki kod nomi, fayl kengaytmasi `.xotira` va shifrlash kontekstlari o‘zgarmadi, shuning uchun eski omborlar ochiladi).
- **Statistikaga rozilik majburiy** (statistika manzili o‘rnatilgan test buildlarda): rozilik bermasdan ilova ishlamaydi, Escape ham o‘tkazmaydi; server ham rozilik yo‘q bo‘lsa so‘rovlarni rad etadi (428). «Lock and close» ombor qulfini yopadi. Statistikani o‘chirsangiz serverdagi barcha ma'lumot (fikrlar ham) o‘chiriladi va rozilik yana so‘raladi.
- **Fikr yuborish:** grafdagi «‹‹» panelida (Graph controls) va Home pastidagi havolada «Send feedback». Faqat yozganingiz, versiya, platforma va til yuboriladi; admin panelida ko‘rinadi (`/admin`).
- **Ishlab chiqaruvchi nomi:** Windows dasturiga `Nurmuhammad` metadata sifatida yozildi. «Noma'lum dasturchi» ogohlantirishi **faqat kod imzolash sertifikati** bilan yo‘qoladi: [docs/SIGNING.md](docs/SIGNING.md).

## v27 yangiliklari

- **Statistika (faqat rozilik bilan):** Home'da «Share anonymous statistics» kartasi. Yuboriladigan ma'lumot oldindan ko'rsatiladi; qayd matni, sarlavha, teg, fayl nomi, parol va IP hech qachon yuborilmaydi. O'chirsangiz serverdagi ma'lumot ham o'chiriladi. Qarang: `stats-worker/README.md`.
- **Cloudflare Worker + D1** (`stats-worker/`): ping qabul qiladi va faqat siz ko'radigan `/admin` panelini beradi (o'rnatishlar, kunlik/haftalik/oylik faol, platforma, versiya, til, davlat, funksiyalar, bosqichlar, qaytib kelish). Testlar: `node --no-warnings --test stats-worker/worker.test.mjs`.
- **Yuklab olish sahifasi** `site/index.html` (Cloudflare Pages/Vercel'ga joylash mumkin): GitHub'dagi oxirgi relizdan foydalanuvchi tizimiga mos faylni topadi.
- Workflow endi versiya tegida GitHub Release yaratadi. Platformalar holati: [docs/PLATFORMS.md](docs/PLATFORMS.md).

## v26 yangiliklari

- **Home** — yangi birinchi ekran: salomlashuv, tezkor amallar (yangi qayd, bugungi qayd, shablon, import), «Get started» ro‘yxati (0/3), sevimlilar, yaqinda tahrirlanganlar va muddati yaqin vazifalar. Olti tilda (EN/UZ/RU/TR/ES/AR).
- Parol yaratish oynasida «parolni tiklab bo‘lmaydi» ogohlantirishi.
- **Windows qo‘llovi:** `fcntl` o‘rniga ikki tizimli blokirovka, `%APPDATA%\Xotira` papkasi, `start.bat`. Windows'da haqiqiy sinovdan o‘tmagan (testda soxta `msvcrt`).
- **Python kerak emas:** `xotira.spec` (PyInstaller) va `.github/workflows/build.yml` Windows/macOS/Linux uchun bitta fayl dastur quradi. Linux dasturi shu yerda qurilib, brauzerda tekshirildi (`tests/smoke_binary.py`).
- Sinovchilar uchun [docs/TESTER_GUIDE.md](docs/TESTER_GUIDE.md).

- **Maxfiylik xatosi tuzatildi:** ommaviy qayd Trash'ga tashlansa yoki butunlay o‘chirilsa, uning ommaviy sahifasi endi avtomatik o‘chadi (avval havola ochiq qolardi).
- **Hamma uchun havola:** Share oynasidagi eski havola faqat shu kompyuterda ochiladi. Yangi **Link for everyone** bo‘limi tanlangan bitta sahifani o‘zingiz boshqaradigan serverga (`publish_server.py`) yuklaydi va boshqa odam ocha oladigan manzil beradi. Qayd Trash'ga tushsa yoki nashr bekor qilinsa, serverdagi nusxa o‘chiriladi; server o‘chiq bo‘lsa, o‘chirish eslab qolinadi va keyingi urinishda takrorlanadi. Qo‘llanma: [docs/HOSTING_V26.md](docs/HOSTING_V26.md).
- Ommaviy sahifada qaydning sarlavhasi, teglari, matni va rasmlari ko‘rinadi. Share oynasi buni aytadi.
- Yangi testlar: `tests/test_v26_privacy.py`, `tests/test_v26_hosting.py`, brauzer testi `python3 tests/browser/hosting_v26.py`.

## v23 tuzatishlari

- Telefonda rasm viewer'i ekranga sig‘adi (avval 720 px rasm 390 px ekrandan chiqib ketardi). Rasmni bosish asl o‘lcham bilan moslashtirilgan ko‘rinish orasida almashtiradi.
- Gorizontal telefonda yon panel qaydlar ro‘yxatini 0 balandlikka siqib qo‘ymaydi; panel scroll bo‘ladi.
- Chizma oynasidagi Saqlash/Bekor tugmalari qisqa ekranda ham ko‘rinib turadi.
- Qayd xususiyatlari: holat, ustuvorlik va muddat bitta qatorda; muddat maydoni alohida qatorga tushib ketmaydi.
- `index.html` dagi inline style'lar olib tashlandi (CSP konsol xatosi yo‘qoldi).
- Agent so‘rovlari ombor bo‘sh turish taymerini uzaytirmaydi (avval javob yozilgandan keyin tiklanardi va test ba’zan yiqilardi).
- Yangi brauzer testi: `python3 tests/browser/layout_v23.py` (kompyuter, telefon, gorizontal telefon).
- Mahsulot yo‘l xaritasi: [docs/PRODUCT_STRATEGY_V23.md](docs/PRODUCT_STRATEGY_V23.md).

## v21 tuzatishlari

- Tez almashganda oldingi qayd yoki fayl so‘rovi yangi ochilgan oynani almashtirib yubormaydi. Trash’ga ko‘chirilgan qayd o‘tish tarixidan chiqadi.
- Xarita boshqa oynada saqlangan bo‘lsa, mahalliy qoralama ekranda qoladi. Uni **Export mind map** bilan olishingiz va **Reload saved map** orqali saqlangan nusxani ochishingiz mumkin.
- Bir paytda qayd matni saqlansa va fayl biriktirilsa, yangi fayl ro‘yxatda qoladi. Trash’ga ko‘chirilgan fayl qayd ro‘yxatidan chiqadi. Markdown tahriri nisbiy havolalar va ichki sarlavhalarni saqlaydi.

## Kundalik ish

- `⌘K` buyruqlar va sarlavhalarni ochadi. `⌘⇧K` ombor matnini qidiradi. Windows/Linux brauzerlarida `Ctrl` ishlatiladi. `⌘D` bugungi qaydni ochadi.
- Qayd uchun tur, holat, ustuvorlik va muddat belgilang. Bog‘lanishlar bo‘limida boshqa qaydga turli ma’nodagi aloqa yarating. Tarixdan matn yoki xususiyatlarning avvalgi talqinini tiklang.
- Xarita rejimlari 3D, 2D, qatlamli va ro‘yxatdan iborat. Katta omborda mavzuni tanlang yoki ro‘yxatdan foydalaning.
- Fayl menyusidan ombor papkasi, Markdown ZIP, veb eksport ZIP, Markdown fayllari va eski qayd xususiyatlarini import qiling.
- Buyruqlar palitrasidagi **Local agent setup** orqali o‘qish ruxsatini yoqing. Yozuv takliflariga alohida ruxsat bering. Ilova ombor qulflanganda kalitni bekor qiladi.

## Kalendar va roadmap

- **Calendar** orqali kunni tanlang va **New event** ni bosing. Mavjud qaydga kalendarda ko‘rinadigan **Due date** hamda eslatma uchun **Remind at** qo‘shish mumkin.
- Ilova ochiq, ombor qulfdan chiqarilgan vaqtda muddati kelgan eslatmalar tugmasi chiqadi. Tizim kalendari orqali ham eslatma olish uchun **Export .ics** yordamida faylni olib, kalendaringizga import qiling va eslatma sozlamasini tekshiring.
- **Roadmaps → New roadmap** kurs shablonini ochadi. Sarlavha, bosqichlar va vazifalarni qaydda tahrirlang. **Project**, **Goal** yoki `roadmap` tegli qaydlarda `##` sarlavha bosqich vazifasini bajaradi. Qaydlar orasidagi **Parent of** va **Belongs to** bog‘lanishlari alohida vazifalarni ham hisobga oladi.
- Qayd yuqorisidagi **Attachments** biriktirmalarni o‘ng panelda ochadi. **+ Mind map** joriy qayd ichiga ishlaydigan xarita joylaydi. Xaritaning yuqori o‘ngidagi **Expand mind map** tugmasi katta oynani ochadi. **Back to note** qaydga qaytaradi. Tanlangan branch va Undo tarixi ikkala ko‘rinishda saqlanadi.
- Qayd, rasm yoki faylni sudrash boshlanishi bilan **Trash** ko‘karadi. Tashlanadigan joy ustida nishon kattalashadi. Yon panel yopiq bo‘lsa, nishon pastki o‘ngda chiqadi. Sensorli ekranda element yonidagi **⠿** tutqichidan sudrang.

[v19 mahsulot va xavfsizlik tahlili](docs/V19_SECURITY_AND_PRODUCT.md).

## Kod va chizma

Rasm oldi va keyiniga qayd muharririda matn yozing. Chizmani ochganda **Edit** bilan o‘zgartiring yoki **Delete** orqali o‘chiring. Tahrir chizmaning fayl identifikatorini saqlaydi. Boshqa oynadagi o‘zgarish tufayli saqlash rad etilsa, tasdiq bilan **Reload drawing** ni ishlatish mumkin.

[T01–T05 ijro va tekshiruv holati](docs/EXECUTION_LEDGER.md).


- Qaydga `/code` yozing yoki uchta backtick bilan o‘ralgan kodni joylang. Til kod tarkibidan aniqlanadi. Yonma-yon ikki kvadrat belgisi kodni nusxalaydi.
- `print("olma")` yozib **Run** tugmasini bosing. Blok tagida `olma` chiqadi. Hozir **Run** oddiy Python (hisoblash, sikl, funksiya va ekranga chiqarish) hamda vaqtinchalik SQLite mashqlari uchun ishlaydi. Har ishga tushirish alohida boshlanadi. Python importlari va tashqi fayllar mavjud emas. JavaScript va boshqa aniqlangan tillar tahrirlash va nusxalash uchun saqlanadi.
- **Drawing** → **Pen**. Shaklni bir harakatda chizing va oxirida ruchka, sichqoncha yoki barmoqni 0,6 soniya ushlab turing. Tekislangan shakl qo‘yib yuborishdan oldin chiqadi. **Tool** ro‘yxatidan shakl tanlang va boshlanish nuqtasidan sudrang. Chizma tepasidagi ↶ va ↷ strelkalari oxirgi amalni bekor qiladi yoki qaytaradi.
- [Kasblar bo‘yicha ish jarayonlari tahlili](docs/WORKFLOW_RESEARCH.md).

## 3D xarita va Mind map

- 3D xarita qaydlarni mavzuga ko‘ra va biriktirmalarni o‘z qaydi yoniga joylashtiradi. **Auto arrange** qidiruv va yo‘l yoritilishini tozalab, joriy ko‘rinishdagi tugunlarni ekranga sig‘diradi. **Manual** rejimida sudralgan joylar saqlanadi.
- Fayl uchun yangi qayd avtomatik yaratilsa, band sarlavhaga raqam qo‘shiladi. Ketma-ket yuklash uzilsa, oldin saqlangan fayllar ro‘yxatda ko‘rinadi.
- «Aloqa doirasi» uchun tugunni qidirib Enter bosing yoki qaydni oching. «Bevosita aloqalar» qo‘shni tugunlar, «2 bog‘lanishgacha» bir oraliq tugun orqali yetiladigan aloqalarni ham ko‘rsatadi.
- **Notes** yonidagi **+** yangi qayd ochadi. Sichqoncha bilan qayd, mind map yoki faylni **Trash** ustiga tashlang. Trash ichidagi **Restore** tugmasi uni qaytaradi.
- **Mind map → New mind map**. **+ Branch** ichki shox, **+ Sibling** tanlangan shox bilan bir tomonda yon shox qo‘shadi. **Delete branch** tanlangan shox va uning ichki shoxlarini o‘chiradi. Bog‘langan qayd omborda saqlanadi. **Undo** shoxlarni tiklaydi. Shoxni tanlab tepadagi shakl ro‘yxatidan to‘rtburchak, doira yoki kapsulani tanlang. Shoxni ushlab sudrasangiz, joyi saqlanadi. Boshqa shoxka ulash uchun **Details → Move branch** ni ishlating.
- **Open branch** yoki ikki marta bosish shox qaydini asosiy oynada ochadi. **Attach files** orqali rasm, PDF, DOCX, PPTX va boshqa fayllarni qo‘shing. Yuqoridagi **‹ Mind map** tugmasi tanlangan shoxga qaytaradi.
- Sichqoncha g‘ildiragi yoki ikki barmoq bilan xaritani yaqinlashtiring. Bo‘sh joyni sudrab suring. Yuqoridagi panel tugmasi **Details** ni boshqaradi. Kompyuterda yon panel bilan o‘rta oyna orasidagi ajratkichni sudrab enini moslang.
- Xaritaning o‘zini olib tashlash uchun **Details → Move mind map to Trash**. **Export mind map** tuzilma va qayd havolalarini chiqaradi. Qaydlar va biriktirmalarni ham ko‘chirish uchun **Export portable vault** ni tanlang.
- [Tanlangan mind-map ilovalari va v15 qarorlari](docs/MIND_MAP_RESEARCH.md).

## Zaxira va tiklash

«Shifrlangan zaxira» `.xotira` faylini beradi. «To‘liq ko‘chma eksport» ZIPida Markdown va biriktirmalar, JSON hamda asl parol bilan ochiladigan shifrlangan ombor nusxasi bor. ZIPdagi Markdown va JSON foydalanuvchi ma’lumotlarini ochiq ko‘rinishda saqlaydi.

```sh
sh start.command --restore-zip /yo‘l/Xotira-Portable.zip --vault /yo‘l/Tiklangan.xotira
sh start.command --vault /yo‘l/Tiklangan.xotira
```

Boshqa brauzer profilida yoki v13 ishlagan eski portdagi xususiyatlarni tiklash tartibi [Migratsiya hujjati](docs/MIGRATION_STRATEGY.md) ichida. Natijalar va qolgan ishlar [muhandislik hisobotida](docs/FINAL_ENGINEERING_REPORT.md).

## Sinov

```sh
python -m unittest discover -s tests -v
node --test tests/*.mjs
node benchmarks/measure_graph.mjs web
```
