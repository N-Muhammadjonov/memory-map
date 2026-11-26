# Xarita o‘lchovi

`node benchmarks/measure_graph.mjs web` Node.js v24.22.3 va Linux yordamida 1 100×620 o‘lchamli sinov yuzasini ishlatadi. Bir xil taqsimotdagi guruhlar va har tugunga ikkita yo‘naltirilgan aloqa yaratiladi. Sinov grafikning JavaScript hisoblash va chizish buyruqlarini yuborish vaqtini hisoblaydi. Canvas konteksti o‘rinbosar, shuning uchun brauzer rasterizatsiyasi, GPU, ekran FPS va input kechikishi bu jadvalga kirmaydi.

| Tugun | Aloqa | v13 joylashuv, ms | v14 joylashuv, ms | v13 kadr CPU median, ms | v14 kadr CPU median, ms | v14 ko‘ringan tugun |
|---:|---:|---:|---:|---:|---:|---:|
| 100 | 200 | 19,18 | 19,62 | 0,97 | 1,59 | 100 |
| 1 000 | 2 000 | 36,76 | 20,74 | 4,70 | 5,26 | 1 000 |
| 10 000 | 20 000 | 555,31 | 67,00 | 72,48 | 5,05 | 1 100 |
| 50 000 | 100 000 | 2 962,24 | 86,54 | 367,51 | 5,21 | 1 100 |

Katta grafikda Canvas ko‘rinishi 1 100 tugun va 6 000 aloqa bilan cheklanadi. Tanlangan tugun, yo‘l, qo‘shnilar va guruh vakillari ustuvor. Qidiruv, guruh tanlash va sahifalangan ro‘yxat boshqa tugunlarga kirishni saqlaydi. Eng qisqa yo‘l berilgan filtr doirasidagi namunadan tashqari tugunlarni ham ko‘radi. Raqamlar bitta ishga tushirishdan olingan.

Texnologiya qarori. Mavjud 2D Canvas proyeksiyasi saqlanadi. Browser main-thread va input kuzatuvi to‘plangach, WebGL instancing yoki workerga o‘tkazish qarorini chiqarish mumkin. Kichik yuklamada tezlik farqi kam. 1 000 tugunni to‘liq UI orqali 1,5 soniyada ochish mezoni hamda haqiqiy 10 000 tugun interaktivligi tasdiqlanmagan.

## v15 o‘lchovi

Xuddi shu 100, 1 000, 10 000 va 50 000 tugun simulyatsiyasida joylashuv vaqtlari mos ravishda 18,02 ms, 26,55 ms, 52,33 ms va 89,29 ms bo‘ldi. Oxirgi ikki holat 1 100 tugunni chizish namunasidan foydalandi. 50 000 sintetik qaydning mavzularini alohida to‘liq tasniflash bir yugurishda 1,45 soniya oldi. Topologiya testi 232 tugunda yetti mavzu va alohida mundarija hosil qildi. Bu o‘lchovlar real foydalanuvchi qurilmasidagi brauzer FPS ko‘rsatkichi sifatida talqin qilinmaydi.
