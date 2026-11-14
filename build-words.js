/* ქართული სიტყვების ერთიანი, მკაცრი ლექსიკონი (მოთამაშეც და ბოტიც ერთსა და იმავეს იყენებს).
   გაშვება:  node build-words.js [მინ_სიხშირე] [ოჯახის_გაფართოება 1/0]       მაგ.: node build-words.js 2 1
   წყაროები: words.base.txt (ინტერნეტიდან ამოკრეფილი) + ka_full.txt (OpenSubtitles სიხშირე, CC-BY-4.0) */
const fs = require('fs');
const URL = 'https://huggingface.co/datasets/StephanAkkerman/frequency-words-2018/resolve/873ed41ca4b26c8d4ab849ab2d40bf0ec2a3dc68/ka/ka_full.txt?download=true';
const minFreq = Number(process.argv[2] || 2), minForms = Number(process.argv[4] || 5), family = (process.argv[3] || '1') === '1';

/* 2-3 ასოიანი სიტყვები: ნებადართულია მხოლოდ ეს ნამდვილი სიტყვები */
const SHORT = new Set(`აი ამ ან არ ას აქ ახ ეგ ეს იქ იმ ის კი მე ჰო რა და თუ შე ცა ხო ხე ჭა ბუ ზე ში ღა ნუ ჰა ოჰ აჰ ეჰ ორ
არა ასე ისე იგი ეგე შენ მას მის მათ მან ვარ ხარ იყო ეყო უყო იცი დაე ხომ რომ არც ჯერ სულ მაშ მეც ანუ ვაი ზედ წინ შიგ სად რას რის რად რით ვინ ვის რამ რაც
მზე რძე თვე ძმა ხმა ტყე დღე წრე მთა ქვა გზა თმა ტბა ხბო ღრუ ომი ჩაი ენა ეზო სკა ექო ერა ორი ათი ასი რვა ერთ სამ ოთხ ხუთ ათ ძია ბარ დრო სმა ჭრა ცდა ცივ ღია დიდ`.split(/\s+/));
/* ფუძის შემდეგ დასაშვები ქართული დაბოლოებები: ბრუნვა, თანდებული, მრავლობითი, ნაწილაკი */
const BASE = ['', 'ი', 'ა', 'ე', 'ო', 'უ', 'ს', 'სა', 'ის', 'ისა', 'მა', 'მ', 'ით', 'ად', 'დ', 'ზე', 'ში', 'თან', 'დან', 'კენ', 'ისკენ', 'სთან', 'ისთან', 'ისთვის', 'სთვის', 'ისგან', 'სგან', 'ივით', 'ას', 'ამ', 'ასთან', 'ისაგან', 'თა', 'ზედ', 'შიგ'];
const PL = ['ებ'], PLE = ['ი', 'ს', 'ის', 'ისა', 'მა', 'ით', 'ად', 'ო', 'ზე', 'ში', 'თან', 'დან', 'კენ', 'ისკენ', 'ისთვის', 'ისგან', 'ისთან', 'ივით', 'თან', 'სთვის', 'სგან'];
const PART = ['', 'ც', 'აც', 'ვე'];
const SUFFIX = new Set();
for (const p of PART) { for (const b of BASE) SUFFIX.add(b + p); for (const e of PLE) SUFFIX.add('ებ' + e + p); }

const OK_END = new Set('აეიოუსნთრმდვც'), EXC = new Set(['იქნებ', 'მაშ', 'სულ', 'ეგ', 'ეჰ', 'აჰ', 'ოჰ', 'ახ']);
const okEnd = w => w.length < 3 || OK_END.has(w[w.length - 1]) || EXC.has(w);


/* ახალი ლოგიკა: ბაზა (words.base.txt) ნდობითაა მიღებული, ვფილტრავთ მხოლოდ საეჭვოს.
   გაშვება: node build-words.js */
(async () => {
    if (!fs.existsSync('words.base.txt')) fs.copyFileSync('words.txt', 'words.base.txt');
    const freq = new Map();
    if (fs.existsSync('ka_full.txt')) for (const line of fs.readFileSync('ka_full.txt', 'utf8').split(/\r?\n/)) {
        const [w, n] = line.trim().split(/\s+/);
        if (w && /^[ა-ჰ]+$/.test(w) && /[აეიოუ]/.test(w)) freq.set(w, Number(n) || 0);
    }
    const read = f => fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).map(x => x.trim()).filter(Boolean) : [];
    const block = new Set(read('blocklist.txt')), allow = new Set(read('allowlist.txt'));
    const all = read('words.base.txt').filter(w => /^[ა-ჰ]+$/.test(w));
    const sorted = all.slice().sort(), inBase = new Set(all), V = 'აეიოუ';
    const lb = p => { let lo = 0, hi = sorted.length; while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < p) lo = m + 1; else hi = m; } return lo; };
    const typoLike = w => w.length >= 4 && V.includes(w[w.length - 1]) && (w[w.length - 1] === w[w.length - 2] && !/ააა|ეეე/.test(w) || (V.includes(w[w.length - 2]) && inBase.has(w.slice(0, -1)) && w[w.length - 1] !== 'ა' && w[w.length - 1] !== 'ო'));
    const forms = a => { let n = 0; for (const stem of [a, a.slice(0, -1)]) { if (stem.length < 3) continue; for (let i = lb(stem); i < sorted.length && sorted[i].startsWith(stem); i++) { const s = sorted[i].slice(stem.length); if (sorted[i] !== a && s && SUFFIX.has(s)) n++; } } return n; };
    const out = new Set(allow), why = { short: 0, four: 0, long: 0, dropped: 0 };
    for (const w of all) {
        if (block.has(w)) continue;
        if (w.length <= 3) { if (SHORT.has(w)) { out.add(w); why.short++; } continue; }
        if ((w.length <= 4 && !okEnd(w)) || typoLike(w)) { why.dropped++; continue; }
        if (w.length === 4) { if ((freq.get(w) || 0) >= 3 || forms(w) >= 3) { out.add(w); why.four++; } else why.dropped++; continue; }
        out.add(w); why.long++;
    }
    const final = [...out].sort();
    fs.writeFileSync('words.txt', final.join('\n') + '\n');
    console.log(`საბაზო: ${all.length} | სულ: ${final.length}`, why);
})().catch(e => { console.error(e.message); process.exit(1); });
