/*
 * gitanalyze.c - Analyse statistique d'un dépôt git à partir de son adresse.
 *
 * Compilation :
 *     gcc -O2 -Wall -o gitanalyze gitanalyze.c
 *
 * Utilisation :
 *     gitanalyze <url-git | chemin-local> [options]
 *
 *     gitanalyze git@github.com:boykopovar/AnyPS5.git
 *     gitanalyze https://github.com/torvalds/linux.git --top 20
 *     gitanalyze ./mon-projet
 *
 * Options :
 *     --top N      nombre de lignes dans les classements (défaut : 10)
 *     --keep       conserve le clone temporaire au lieu de le supprimer
 *     --no-color   désactive les couleurs ANSI
 *     -h, --help   affiche l'aide
 *
 * Le programme a besoin de la commande `git` dans le PATH. Il clone le dépôt
 * dans un dossier temporaire, lit l'historique avec `git log --numstat`,
 * parcourt les fichiers suivis puis affiche les statistiques.
 * Si le clone SSH échoue (pas de clé configurée), il réessaie en HTTPS.
 */

#define __USE_MINGW_ANSI_STDIO 1
#ifdef _WIN32
#  define _CRT_SECURE_NO_WARNINGS
#  include <windows.h>
#  include <io.h>
#  define POPEN _popen
#  define PCLOSE _pclose
#  define DEVNULL "nul"
#else
#  include <unistd.h>
#  define POPEN popen
#  define PCLOSE pclose
#  define DEVNULL "/dev/null"
#endif

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <ctype.h>
#include <time.h>
#include <stdint.h>
#include <stdarg.h>

/* ------------------------------------------------------------------------ */
/* Utilitaires généraux                                                     */
/* ------------------------------------------------------------------------ */

static int g_color = 1;
static int g_top = 10;

#define COL(code) (g_color ? "\x1b[" code "m" : "")
#define RST  COL("0")
#define BOLD COL("1")
#define DIM  COL("90")
#define CYAN COL("36")
#define GRN  COL("32")
#define RED  COL("31")
#define YEL  COL("33")
#define MAG  COL("35")

static void die(const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    fprintf(stderr, "Erreur : ");
    vfprintf(stderr, fmt, ap);
    fprintf(stderr, "\n");
    va_end(ap);
    exit(1);
}

static void *xmalloc(size_t n)
{
    void *p = malloc(n ? n : 1);
    if (!p) die("mémoire insuffisante");
    return p;
}

static void *xrealloc(void *p, size_t n)
{
    p = realloc(p, n ? n : 1);
    if (!p) die("mémoire insuffisante");
    return p;
}

static char *xstrdup(const char *s)
{
    size_t n = strlen(s) + 1;
    char *d = xmalloc(n);
    memcpy(d, s, n);
    return d;
}

/* Agrandit un tableau dynamique si nécessaire. */
#define GROW(arr, count, cap)                                              \
    do {                                                                   \
        if ((count) >= (cap)) {                                            \
            (cap) = (cap) ? (cap) * 2 : 64;                                \
            (arr) = xrealloc((arr), (size_t)(cap) * sizeof(*(arr)));       \
        }                                                                  \
    } while (0)

/* Nombre avec séparateur de milliers ("12 345"). Tampons tournants. */
static const char *fnum(long long v)
{
    static char bufs[16][32];
    static int k;
    char *b = bufs[k++ & 15], tmp[32], *p = b;
    unsigned long long u = v < 0 ? (unsigned long long)(-(v + 1)) + 1 : (unsigned long long)v;
    int len, i;
    snprintf(tmp, sizeof tmp, "%llu", u);
    len = (int)strlen(tmp);
    if (v < 0) *p++ = '-';
    for (i = 0; i < len; i++) {
        if (i && (len - i) % 3 == 0) *p++ = ' ';
        *p++ = tmp[i];
    }
    *p = 0;
    return b;
}

/* Taille lisible ("12.3 Mo"). */
static const char *fsize(long long bytes)
{
    static char bufs[8][32];
    static int k;
    char *b = bufs[k++ & 7];
    const char *u[] = {"o", "Ko", "Mo", "Go", "To"};
    double v = (double)bytes;
    int i = 0;
    while (v >= 1024.0 && i < 4) { v /= 1024.0; i++; }
    if (i == 0) snprintf(b, 32, "%lld o", bytes);
    else snprintf(b, 32, "%.1f %s", v, u[i]);
    return b;
}

static const char *fdate(long long ts)
{
    static char bufs[8][32];
    static int k;
    char *b = bufs[k++ & 7];
    time_t t = (time_t)ts;
    struct tm *tm = localtime(&t);
    if (!tm) { strcpy(b, "?"); return b; }
    strftime(b, 32, "%Y-%m-%d", tm);
    return b;
}

static const char *fduration(long long secs)
{
    static char bufs[4][64];
    static int k;
    char *b = bufs[k++ & 3];
    long long days = secs / 86400;
    long long years = days / 365, months = (days % 365) / 30;
    if (years > 0) snprintf(b, 64, "%lld an%s %lld mois (%s jours)", years, years > 1 ? "s" : "", months, fnum(days));
    else if (months > 0) snprintf(b, 64, "%lld mois (%s jours)", months, fnum(days));
    else snprintf(b, 64, "%s jour%s", fnum(days), days > 1 ? "s" : "");
    return b;
}

/* Nombre de caractères affichés d'une chaîne UTF-8. */
static int utf8_width(const char *s)
{
    int w = 0;
    for (; *s; s++)
        if (((unsigned char)*s & 0xC0) != 0x80) w++;
    return w;
}

/* Affiche s sur exactement `width` colonnes (tronque avec "…" ou complète). */
static void put_padded(const char *s, int width, int right_align)
{
    int w = utf8_width(s);
    if (w <= width) {
        if (right_align) printf("%*s%s", width - w, "", s);
        else printf("%s%*s", s, width - w, "");
        return;
    }
    /* Troncature sur une frontière de caractère. */
    int shown = 0;
    const char *p = s;
    while (*p && shown < width - 1) {
        p++;
        while (*p && ((unsigned char)*p & 0xC0) == 0x80) p++;
        shown++;
    }
    fwrite(s, 1, (size_t)(p - s), stdout);
    fputs("…", stdout);
}

static void bar(long long v, long long max, int width, const char *color)
{
    int n = 0, i;
    if (max > 0) n = (int)((v * width + max / 2) / max);
    if (v > 0 && n == 0) n = 1;
    printf("%s", color);
    for (i = 0; i < n; i++) fputs("█", stdout);
    printf("%s", RST);
}

static void section(const char *title)
{
    printf("\n%s%s━━ %s ", BOLD, CYAN, title);
    int i, w = 70 - utf8_width(title);
    for (i = 0; i < w; i++) fputs("━", stdout);
    printf("%s\n\n", RST);
}

static void kv(const char *key, const char *fmt, ...)
{
    va_list ap;
    printf("  %s", DIM);
    put_padded(key, 28, 0);
    printf("%s ", RST);
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    printf("\n");
}

static double pct(long long a, long long b) { return b ? 100.0 * (double)a / (double)b : 0.0; }

/* ------------------------------------------------------------------------ */
/* Table de hachage chaîne -> entier                                        */
/* ------------------------------------------------------------------------ */

typedef struct {
    char **keys;
    int *vals;
    size_t cap, count;
} Map;

static uint64_t fnv1a(const char *s)
{
    uint64_t h = 1469598103934665603ULL;
    while (*s) { h ^= (unsigned char)*s++; h *= 1099511628211ULL; }
    return h;
}

static void map_insert_owned(Map *m, char *key, int v)
{
    size_t i = (size_t)fnv1a(key) & (m->cap - 1);
    while (m->keys[i]) i = (i + 1) & (m->cap - 1);
    m->keys[i] = key;
    m->vals[i] = v;
    m->count++;
}

static void map_grow(Map *m)
{
    size_t oc = m->cap, i;
    char **ok = m->keys;
    int *ov = m->vals;
    m->cap = oc ? oc * 2 : 256;
    m->keys = calloc(m->cap, sizeof(char *));
    m->vals = calloc(m->cap, sizeof(int));
    if (!m->keys || !m->vals) die("mémoire insuffisante");
    m->count = 0;
    for (i = 0; i < oc; i++)
        if (ok[i]) map_insert_owned(m, ok[i], ov[i]);
    free(ok);
    free(ov);
}

static int map_get(const Map *m, const char *k)
{
    if (!m->cap) return -1;
    size_t i = (size_t)fnv1a(k) & (m->cap - 1);
    while (m->keys[i]) {
        if (!strcmp(m->keys[i], k)) return m->vals[i];
        i = (i + 1) & (m->cap - 1);
    }
    return -1;
}

static void map_set(Map *m, const char *k, int v)
{
    if ((m->count + 1) * 10 >= m->cap * 7) map_grow(m);
    map_insert_owned(m, xstrdup(k), v);
}

/* ------------------------------------------------------------------------ */
/* Exécution de commandes                                                   */
/* ------------------------------------------------------------------------ */

/* Lit une ligne de longueur quelconque, sans le \r\n final. -1 en fin. */
static long read_line(FILE *f, char **buf, size_t *cap)
{
    size_t len = 0;
    int c = EOF;
    if (!*buf) { *cap = 1024; *buf = xmalloc(*cap); }
    while ((c = getc(f)) != EOF) {
        if (c == '\n') break;
        if (len + 1 >= *cap) { *cap *= 2; *buf = xrealloc(*buf, *cap); }
        (*buf)[len++] = (char)c;
    }
    if (c == EOF && len == 0) return -1;
    while (len && (*buf)[len - 1] == '\r') len--;
    (*buf)[len] = 0;
    return (long)len;
}

/* Refuse les caractères qui pourraient être interprétés par le shell. */
static int is_shell_safe(const char *s)
{
    for (; *s; s++)
        if (strchr("\"`$;&|<>^%\r\n", *s)) return 0;
    return 1;
}

/* Exécute une commande et renvoie la première ligne de sa sortie. */
static int run_first_line(const char *cmd, char *out, size_t n)
{
    FILE *p = POPEN(cmd, "r");
    char *buf = NULL;
    size_t cap = 0;
    out[0] = 0;
    if (!p) return -1;
    if (read_line(p, &buf, &cap) >= 0) {
        strncpy(out, buf, n - 1);
        out[n - 1] = 0;
    }
    while (read_line(p, &buf, &cap) >= 0) {}
    free(buf);
    return PCLOSE(p);
}

static long run_count_lines(const char *cmd, const char *skip_if_contains)
{
    FILE *p = POPEN(cmd, "r");
    char *buf = NULL;
    size_t cap = 0;
    long n = 0;
    if (!p) return -1;
    while (read_line(p, &buf, &cap) >= 0) {
        if (!buf[0]) continue;
        if (skip_if_contains && strstr(buf, skip_if_contains)) continue;
        n++;
    }
    free(buf);
    PCLOSE(p);
    return n;
}

/* ------------------------------------------------------------------------ */
/* Structures de statistiques                                               */
/* ------------------------------------------------------------------------ */

typedef struct {
    char *name, *email;
    int commits, merges;
    long long add, del;
    long long first, last;
} Author;

typedef struct {
    char hash[12];
    char *subject;
    int author;
    const char *author_name; /* reste valide après le tri des auteurs */
    long long ts;
    int y, mo, d, h, wd; /* date locale de l'auteur, wd : 0 = lundi */
    long day;            /* numéro de jour civil */
    int merge;
    int files;
    long long add, del;
} Commit;

typedef struct {
    char *path;
    int commits;
    long long add, del;
} Churn;

typedef struct {
    char *path;
    long long lines, blank, bytes;
    int binary;
} File;

typedef struct {
    char *name;
    int files;
    long long lines, blank, bytes;
} Lang;

static Author *authors; static int n_authors, cap_authors;
static Commit *commits; static int n_commits, cap_commits;
static Churn  *churn;   static int n_churn,   cap_churn;
static File   *files;   static int n_files,   cap_files;
static Lang   *langs;   static int n_langs,   cap_langs;
static Map author_map, churn_map, lang_map;

/* ------------------------------------------------------------------------ */
/* Dates                                                                    */
/* ------------------------------------------------------------------------ */

/* Jours depuis 1970-01-01 (algorithme de H. Hinnant). */
static long days_from_civil(int y, int m, int d)
{
    y -= m <= 2;
    long era = (y >= 0 ? y : y - 399) / 400;
    unsigned yoe = (unsigned)(y - era * 400);
    unsigned doy = (unsigned)((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1);
    unsigned doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + (long)doe - 719468;
}

static void civil_from_days(long z, int *y, int *m, int *d)
{
    z += 719468;
    long era = (z >= 0 ? z : z - 146096) / 146097;
    unsigned doe = (unsigned)(z - era * 146097);
    unsigned yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    long yy = (long)yoe + era * 400;
    unsigned doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    unsigned mp = (5 * doy + 2) / 153;
    *d = (int)(doy - (153 * mp + 2) / 5 + 1);
    *m = (int)(mp < 10 ? mp + 3 : mp - 9);
    *y = (int)(yy + (*m <= 2));
}

static const char *WEEKDAYS[7] = {"Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"};
static const char *MONTHS[12] = {"jan", "fév", "mar", "avr", "mai", "jui", "jul", "aoû", "sep", "oct", "nov", "déc"};

/* ------------------------------------------------------------------------ */
/* Lecture de l'historique                                                  */
/* ------------------------------------------------------------------------ */

static int get_author(const char *name, const char *email)
{
    char key[512];
    size_t i;
    /* Regroupe par nom (comme git shortlog) : un même auteur a souvent plusieurs emails. */
    snprintf(key, sizeof key, "%s", name[0] ? name : email);
    for (i = 0; key[i]; i++) key[i] = (char)tolower((unsigned char)key[i]);
    int idx = map_get(&author_map, key);
    if (idx >= 0) return idx;
    GROW(authors, n_authors, cap_authors);
    Author *a = &authors[n_authors];
    memset(a, 0, sizeof *a);
    a->name = xstrdup(name[0] ? name : email);
    a->email = xstrdup(email);
    a->first = INT64_MAX;
    a->last = INT64_MIN;
    map_set(&author_map, key, n_authors);
    return n_authors++;
}

static Churn *get_churn(const char *path)
{
    int idx = map_get(&churn_map, path);
    if (idx < 0) {
        GROW(churn, n_churn, cap_churn);
        memset(&churn[n_churn], 0, sizeof(Churn));
        churn[n_churn].path = xstrdup(path);
        map_set(&churn_map, path, n_churn);
        idx = n_churn++;
    }
    return &churn[idx];
}

/* Découpe s selon sep (en place). Renvoie le nombre de champs. */
static int split(char *s, char sep, char **fields, int max)
{
    int n = 0;
    fields[n++] = s;
    while (*s && n < max) {
        if (*s == sep) { *s = 0; fields[n++] = s + 1; }
        s++;
    }
    return n;
}

static void parse_log(const char *dir)
{
    char cmd[8192];
    /* %x1f = séparateur de champ ; %ai = date ISO dans le fuseau de l'auteur. */
    snprintf(cmd, sizeof cmd,
             "git -C \"%s\" -c core.quotepath=off log --no-renames --numstat "
             "\"--pretty=format:@@@%%x1f%%H%%x1f%%an%%x1f%%ae%%x1f%%at%%x1f%%ai%%x1f%%P%%x1f%%s\" 2>" DEVNULL,
             dir);
    FILE *p = POPEN(cmd, "r");
    if (!p) die("impossible de lancer git log");

    char *buf = NULL;
    size_t cap = 0;
    Commit *cur = NULL;
    while (read_line(p, &buf, &cap) >= 0) {
        if (!buf[0]) continue;
        if (!strncmp(buf, "@@@\x1f", 4)) {
            char *f[8];
            if (split(buf + 4, '\x1f', f, 7) < 7) continue;
            /* f: 0 hash, 1 nom, 2 email, 3 timestamp, 4 date iso, 5 parents, 6 sujet */
            GROW(commits, n_commits, cap_commits);
            cur = &commits[n_commits++];
            memset(cur, 0, sizeof *cur);
            snprintf(cur->hash, sizeof cur->hash, "%.10s", f[0]);
            cur->subject = xstrdup(f[6]);
            cur->ts = strtoll(f[3], NULL, 10);
            if (sscanf(f[4], "%d-%d-%d %d", &cur->y, &cur->mo, &cur->d, &cur->h) != 4) {
                cur->y = 1970; cur->mo = 1; cur->d = 1; cur->h = 0;
            }
            cur->day = days_from_civil(cur->y, cur->mo, cur->d);
            cur->wd = (int)(((cur->day % 7) + 7 + 3) % 7);
            cur->merge = strchr(f[5], ' ') != NULL;
            cur->author = get_author(f[1], f[2]);

            Author *a = &authors[cur->author];
            cur->author_name = a->name;
            a->commits++;
            if (cur->merge) a->merges++;
            if (cur->ts < a->first) a->first = cur->ts;
            if (cur->ts > a->last) a->last = cur->ts;
            continue;
        }
        if (!cur) continue;
        /* Ligne numstat : "ajouts\tsuppressions\tchemin" ("-" pour un binaire). */
        char *f[3];
        if (split(buf, '\t', f, 3) < 3) continue;
        long long ad = f[0][0] == '-' ? 0 : strtoll(f[0], NULL, 10);
        long long de = f[1][0] == '-' ? 0 : strtoll(f[1], NULL, 10);
        cur->add += ad;
        cur->del += de;
        cur->files++;
        authors[cur->author].add += ad;
        authors[cur->author].del += de;
        Churn *c = get_churn(f[2]);
        c->commits++;
        c->add += ad;
        c->del += de;
    }
    free(buf);
    PCLOSE(p);
}

/* ------------------------------------------------------------------------ */
/* Analyse des fichiers suivis                                              */
/* ------------------------------------------------------------------------ */

static const struct { const char *ext, *lang; } LANG_TABLE[] = {
    {"c", "C"}, {"h", "C/C++ Header"}, {"cpp", "C++"}, {"cc", "C++"}, {"cxx", "C++"},
    {"hpp", "C++ Header"}, {"hh", "C++ Header"}, {"hxx", "C++ Header"}, {"cs", "C#"},
    {"java", "Java"}, {"kt", "Kotlin"}, {"kts", "Kotlin"}, {"scala", "Scala"}, {"go", "Go"},
    {"rs", "Rust"}, {"py", "Python"}, {"pyw", "Python"}, {"rb", "Ruby"}, {"php", "PHP"},
    {"js", "JavaScript"}, {"mjs", "JavaScript"}, {"cjs", "JavaScript"}, {"jsx", "JavaScript JSX"},
    {"ts", "TypeScript"}, {"tsx", "TypeScript TSX"}, {"swift", "Swift"}, {"m", "Objective-C"},
    {"mm", "Objective-C++"}, {"dart", "Dart"}, {"lua", "Lua"}, {"pl", "Perl"}, {"pm", "Perl"},
    {"r", "R"}, {"sh", "Shell"}, {"bash", "Shell"}, {"zsh", "Shell"}, {"fish", "Shell"},
    {"ps1", "PowerShell"}, {"psm1", "PowerShell"}, {"bat", "Batch"}, {"cmd", "Batch"},
    {"html", "HTML"}, {"htm", "HTML"}, {"css", "CSS"}, {"scss", "SCSS"}, {"sass", "Sass"},
    {"less", "Less"}, {"vue", "Vue"}, {"svelte", "Svelte"}, {"json", "JSON"}, {"xml", "XML"},
    {"yml", "YAML"}, {"yaml", "YAML"}, {"toml", "TOML"}, {"ini", "INI"}, {"cfg", "Config"},
    {"conf", "Config"}, {"md", "Markdown"}, {"rst", "reStructuredText"}, {"txt", "Texte"},
    {"sql", "SQL"}, {"cmake", "CMake"}, {"asm", "Assembleur"}, {"s", "Assembleur"},
    {"hs", "Haskell"}, {"ex", "Elixir"}, {"exs", "Elixir"}, {"erl", "Erlang"},
    {"clj", "Clojure"}, {"fs", "F#"}, {"vb", "Visual Basic"}, {"zig", "Zig"}, {"nim", "Nim"},
    {"jl", "Julia"}, {"gradle", "Gradle"}, {"proto", "Protobuf"}, {"ipynb", "Jupyter"},
    {"csv", "CSV"}, {"svg", "SVG"}, {"tex", "LaTeX"}, {"gd", "GDScript"}, {"glsl", "GLSL"},
    {"hlsl", "HLSL"}, {"sln", "Visual Studio"}, {"csproj", "Visual Studio"},
    {"vcxproj", "Visual Studio"}, {"plist", "XML"}, {"lock", "Lockfile"},
};

static void lang_of(const char *path, char *out, size_t n)
{
    const char *base = strrchr(path, '/');
    base = base ? base + 1 : path;
    if (!strcmp(base, "Makefile") || !strcmp(base, "makefile") || !strcmp(base, "GNUmakefile")) { snprintf(out, n, "Makefile"); return; }
    if (!strcmp(base, "Dockerfile")) { snprintf(out, n, "Dockerfile"); return; }
    if (!strcmp(base, "CMakeLists.txt")) { snprintf(out, n, "CMake"); return; }

    const char *dot = strrchr(base, '.');
    if (!dot || dot == base) {
        snprintf(out, n, "%s", dot ? base : "(sans extension)");
        return;
    }
    char ext[64];
    size_t i;
    snprintf(ext, sizeof ext, "%s", dot + 1);
    for (i = 0; ext[i]; i++) ext[i] = (char)tolower((unsigned char)ext[i]);
    for (i = 0; i < sizeof LANG_TABLE / sizeof LANG_TABLE[0]; i++)
        if (!strcmp(LANG_TABLE[i].ext, ext)) { snprintf(out, n, "%s", LANG_TABLE[i].lang); return; }
    snprintf(out, n, ".%s", ext);
}

static void scan_file(const char *dir, const char *path)
{
    char full[8192];
    snprintf(full, sizeof full, "%s/%s", dir, path);
    FILE *f = fopen(full, "rb");
    if (!f) return; /* lien symbolique cassé, sous-module, etc. */

    GROW(files, n_files, cap_files);
    File *fi = &files[n_files++];
    memset(fi, 0, sizeof *fi);
    fi->path = xstrdup(path);

    static unsigned char chunk[65536];
    size_t r, i;
    int first = 1, line_has_text = 0, last = '\n';
    while ((r = fread(chunk, 1, sizeof chunk, f)) > 0) {
        if (first) {
            size_t lim = r < 8000 ? r : 8000;
            if (memchr(chunk, 0, lim)) fi->binary = 1;
            first = 0;
        }
        fi->bytes += (long long)r;
        if (fi->binary) continue;
        for (i = 0; i < r; i++) {
            unsigned char c = chunk[i];
            if (c == '\n') {
                fi->lines++;
                if (!line_has_text) fi->blank++;
                line_has_text = 0;
            } else if (!isspace(c)) {
                line_has_text = 1;
            }
        }
        last = chunk[r - 1];
    }
    fclose(f);
    if (!fi->binary && fi->bytes > 0 && last != '\n') {
        fi->lines++;
        if (!line_has_text) fi->blank++;
    }
    if (fi->binary) return;

    char lang[128];
    lang_of(path, lang, sizeof lang);
    int idx = map_get(&lang_map, lang);
    if (idx < 0) {
        GROW(langs, n_langs, cap_langs);
        memset(&langs[n_langs], 0, sizeof(Lang));
        langs[n_langs].name = xstrdup(lang);
        map_set(&lang_map, lang, n_langs);
        idx = n_langs++;
    }
    langs[idx].files++;
    langs[idx].lines += fi->lines;
    langs[idx].blank += fi->blank;
    langs[idx].bytes += fi->bytes;
}

static void scan_files(const char *dir)
{
    char cmd[8192];
    snprintf(cmd, sizeof cmd, "git -C \"%s\" -c core.quotepath=off ls-files 2>" DEVNULL, dir);
    FILE *p = POPEN(cmd, "r");
    if (!p) return;
    char *buf = NULL;
    size_t cap = 0;
    while (read_line(p, &buf, &cap) >= 0)
        if (buf[0]) scan_file(dir, buf);
    free(buf);
    PCLOSE(p);
}

/* ------------------------------------------------------------------------ */
/* Tris                                                                     */
/* ------------------------------------------------------------------------ */

static int cmp_author(const void *a, const void *b)
{
    const Author *x = a, *y = b;
    if (x->commits != y->commits) return y->commits - x->commits;
    return (y->add + y->del > x->add + x->del) - (y->add + y->del < x->add + x->del);
}
static int cmp_churn(const void *a, const void *b)
{
    const Churn *x = a, *y = b;
    if (x->commits != y->commits) return y->commits - x->commits;
    return (y->add + y->del > x->add + x->del) - (y->add + y->del < x->add + x->del);
}
static int cmp_file_lines(const void *a, const void *b)
{
    const File *x = a, *y = b;
    return (y->lines > x->lines) - (y->lines < x->lines);
}
static int cmp_lang(const void *a, const void *b)
{
    const Lang *x = a, *y = b;
    return (y->lines > x->lines) - (y->lines < x->lines);
}
static int cmp_commit_size(const void *a, const void *b)
{
    const Commit *const *x = a, *const *y = b;
    long long sx = (*x)->add + (*x)->del, sy = (*y)->add + (*y)->del;
    return (sy > sx) - (sy < sx);
}
static int cmp_long(const void *a, const void *b)
{
    long x = *(const long *)a, y = *(const long *)b;
    return (x > y) - (x < y);
}

/* ------------------------------------------------------------------------ */
/* Clonage                                                                  */
/* ------------------------------------------------------------------------ */

static int is_git_repo(const char *path)
{
    char cmd[8192], out[256];
    snprintf(cmd, sizeof cmd, "git -C \"%s\" rev-parse --git-dir 2>" DEVNULL, path);
    return run_first_line(cmd, out, sizeof out) == 0 && out[0];
}

static void make_temp_dir(char *out, size_t n)
{
#ifdef _WIN32
    char tmp[MAX_PATH];
    DWORD len = GetTempPathA(MAX_PATH, tmp);
    if (!len) strcpy(tmp, ".\\");
    snprintf(out, n, "%sgitanalyze_%lu_%lu", tmp, (unsigned long)GetCurrentProcessId(), (unsigned long)time(NULL));
#else
    char tmpl[] = "/tmp/gitanalyze_XXXXXX";
    if (!mkdtemp(tmpl)) die("impossible de créer un dossier temporaire");
    snprintf(out, n, "%s/repo", tmpl);
#endif
}

static void remove_dir(const char *dir)
{
    char cmd[8192];
#ifdef _WIN32
    if (GetFileAttributesA(dir) == INVALID_FILE_ATTRIBUTES) return; /* rien à supprimer */
    snprintf(cmd, sizeof cmd, "rmdir /s /q \"%s\" >nul 2>&1", dir);
#else
    /* Le clone est dans <tmp>/repo : on supprime le dossier parent. */
    char parent[4096];
    snprintf(parent, sizeof parent, "%s", dir);
    char *s = strrchr(parent, '/');
    if (s) *s = 0;
    snprintf(cmd, sizeof cmd, "rm -rf \"%s\"", parent);
#endif
    if (system(cmd) != 0) fprintf(stderr, "Attention : impossible de supprimer %s\n", dir);
}

static int git_clone(const char *url, const char *dir)
{
    char cmd[8192];
    fprintf(stderr, "%sClonage de %s ...%s\n", DIM, url, RST);
    fflush(stderr);
    snprintf(cmd, sizeof cmd, "git clone --quiet \"%s\" \"%s\"", url, dir);
    return system(cmd) == 0;
}

/* git@host:owner/repo.git -> https://host/owner/repo.git */
static int ssh_to_https(const char *url, char *out, size_t n)
{
    const char *at = strchr(url, '@'), *colon;
    if (strncmp(url, "git@", 4) != 0 || !at) return 0;
    colon = strchr(at, ':');
    if (!colon) return 0;
    snprintf(out, n, "https://%.*s/%s", (int)(colon - at - 1), at + 1, colon + 1);
    return 1;
}

/* Extrait le nom du dépôt de l'URL ("AnyPS5"). */
static void repo_name(const char *url, char *out, size_t n)
{
    char tmp[1024];
    snprintf(tmp, sizeof tmp, "%s", url);
    size_t len = strlen(tmp);
    while (len && (tmp[len - 1] == '/' || tmp[len - 1] == '\\')) tmp[--len] = 0;
    if (len > 4 && !strcmp(tmp + len - 4, ".git")) tmp[len -= 4] = 0;
    char *s = tmp + len;
    while (s > tmp && s[-1] != '/' && s[-1] != '\\' && s[-1] != ':') s--;
    snprintf(out, n, "%s", s);
}

/* ------------------------------------------------------------------------ */
/* Affichage                                                                */
/* ------------------------------------------------------------------------ */

/* Informations générales sur le dépôt (partagées par le texte et le HTML). */
static char g_branch[256] = "?", g_remote[1024] = "";
static long long g_all_commits, g_git_size;
static long g_branches, g_tags;

static void collect_repo_info(const char *dir)
{
    char cmd[8192], buf[1024];

    snprintf(cmd, sizeof cmd, "git -C \"%s\" rev-parse --abbrev-ref HEAD 2>" DEVNULL, dir);
    run_first_line(cmd, g_branch, sizeof g_branch);
    snprintf(cmd, sizeof cmd, "git -C \"%s\" config --get remote.origin.url 2>" DEVNULL, dir);
    run_first_line(cmd, g_remote, sizeof g_remote);
    snprintf(cmd, sizeof cmd, "git -C \"%s\" rev-list --all --count 2>" DEVNULL, dir);
    run_first_line(cmd, buf, sizeof buf);
    g_all_commits = strtoll(buf, NULL, 10);
    snprintf(cmd, sizeof cmd, "git -C \"%s\" branch -r 2>" DEVNULL, dir);
    g_branches = run_count_lines(cmd, "->");
    if (g_branches <= 0) {
        snprintf(cmd, sizeof cmd, "git -C \"%s\" branch 2>" DEVNULL, dir);
        g_branches = run_count_lines(cmd, NULL);
    }
    snprintf(cmd, sizeof cmd, "git -C \"%s\" tag 2>" DEVNULL, dir);
    g_tags = run_count_lines(cmd, NULL);

    snprintf(cmd, sizeof cmd, "git -C \"%s\" count-objects -v 2>" DEVNULL, dir);
    FILE *p = POPEN(cmd, "r");
    char *line = NULL;
    size_t cap = 0;
    if (p) {
        while (read_line(p, &line, &cap) >= 0)
            if (!strncmp(line, "size: ", 6) || !strncmp(line, "size-pack: ", 11))
                g_git_size += strtoll(strchr(line, ':') + 1, NULL, 10) * 1024;
        free(line);
        PCLOSE(p);
    }
}

static void print_report(const char *url)
{
    const char *branch = g_branch, *remote_url = g_remote;
    long long all_commits = g_all_commits, git_size = g_git_size;
    long n_branches = g_branches, n_tags = g_tags;
    int i;

    /* Totaux sur l'historique */
    long long tot_add = 0, tot_del = 0, first_ts = INT64_MAX, last_ts = INT64_MIN;
    int n_merges = 0, first_i = 0, last_i = 0;
    long long subj_len = 0;
    int short_msgs = 0;
    for (i = 0; i < n_commits; i++) {
        Commit *c = &commits[i];
        tot_add += c->add;
        tot_del += c->del;
        if (c->merge) n_merges++;
        if (c->ts < first_ts) { first_ts = c->ts; first_i = i; }
        if (c->ts > last_ts) { last_ts = c->ts; last_i = i; }
        int sl = utf8_width(c->subject);
        subj_len += sl;
        if (sl < 10) short_msgs++;
    }

    /* Jours actifs et plus longue série */
    long *days = xmalloc(sizeof(long) * ((size_t)n_commits + 1));
    for (i = 0; i < n_commits; i++) days[i] = commits[i].day;
    qsort(days, (size_t)n_commits, sizeof(long), cmp_long);
    int active_days = 0, streak = 0, best_streak = 0;
    long best_end = 0;
    for (i = 0; i < n_commits; i++) {
        if (i && days[i] == days[i - 1]) continue;
        active_days++;
        streak = (i && days[i] == days[i - 1] + 1) ? streak + 1 : 1;
        if (streak > best_streak) { best_streak = streak; best_end = days[i]; }
    }
    free(days);

    /* ================= GÉNÉRAL ================= */
    char name[256];
    repo_name(url, name, sizeof name);
    printf("\n%s%s  Analyse du dépôt « %s »%s\n", BOLD, MAG, name, RST);

    section("Général");
    kv("Adresse", "%s", remote_url[0] ? remote_url : url);
    kv("Branche analysée", "%s", branch);
    if (n_commits) {
        Commit *lc = &commits[last_i];
        kv("Dernier commit", "%s%s%s  %s", YEL, lc->hash, RST, lc->subject);
    }
    kv("Commits (branche)", "%s  %s(dont %s merges)%s", fnum(n_commits), DIM, fnum(n_merges), RST);
    kv("Commits (toutes branches)", "%s", fnum(all_commits));
    kv("Branches", "%s", fnum(n_branches));
    kv("Tags", "%s", fnum(n_tags));
    kv("Contributeurs", "%s", fnum(n_authors));
    kv("Taille du dépôt (.git)", "%s", fsize(git_size));

    if (!n_commits) {
        printf("\n  Aucun commit trouvé.\n");
        return;
    }

    section("Chronologie");
    time_t now = time(NULL);
    kv("Premier commit", "%s  %s(%s)%s", fdate(first_ts), DIM, commits[first_i].author_name, RST);
    kv("Dernier commit", "%s  %s(il y a %s)%s", fdate(last_ts), DIM, fduration((long long)now - last_ts), RST);
    kv("Durée de vie", "%s", fduration(last_ts - first_ts));
    kv("Jours actifs", "%s  %s(%.1f%% des jours)%s", fnum(active_days), DIM,
       pct(active_days, (last_ts - first_ts) / 86400 + 1), RST);
    {
        int y, m, d, y2, m2, d2;
        civil_from_days(best_end - best_streak + 1, &y, &m, &d);
        civil_from_days(best_end, &y2, &m2, &d2);
        kv("Plus longue série", "%d jour%s consécutif%s  %s(%04d-%02d-%02d → %04d-%02d-%02d)%s",
           best_streak, best_streak > 1 ? "s" : "", best_streak > 1 ? "s" : "",
           DIM, y, m, d, y2, m2, d2, RST);
    }
    kv("Commits / jour actif", "%.2f", (double)n_commits / (active_days ? active_days : 1));
    {
        double weeks = (double)(last_ts - first_ts) / (86400.0 * 7);
        kv("Commits / semaine", "%.2f", weeks >= 1 ? n_commits / weeks : (double)n_commits);
    }

    section("Volume de code (historique)");
    kv("Lignes ajoutées", "%s+%s%s", GRN, fnum(tot_add), RST);
    kv("Lignes supprimées", "%s-%s%s", RED, fnum(tot_del), RST);
    kv("Solde", "%s", fnum(tot_add - tot_del));
    kv("Lignes modifiées / commit", "%.1f", (double)(tot_add + tot_del) / (n_commits - n_merges ? n_commits - n_merges : 1));
    kv("Fichiers ayant existé", "%s", fnum(n_churn));

    /* ================= CONTRIBUTEURS ================= */
    qsort(authors, (size_t)n_authors, sizeof(Author), cmp_author);
    section("Contributeurs");
    printf("  %s%-3s %-24s %8s %6s %10s %10s  %-10s  %-10s%s\n", BOLD, "#", "Auteur", "Commits", "%",
           "Ajouts", "Suppr.", "Premier", "Dernier", RST);
    for (i = 0; i < n_authors && i < g_top; i++) {
        Author *a = &authors[i];
        printf("  %-3d ", i + 1);
        put_padded(a->name, 24, 0);
        printf(" %8s %5.1f%% %s%10s%s %s%10s%s  %-10s  %-10s\n", fnum(a->commits), pct(a->commits, n_commits),
               GRN, fnum(a->add), RST, RED, fnum(a->del), RST, fdate(a->first), fdate(a->last));
    }
    if (n_authors > g_top) printf("  %s... et %d autre(s)%s\n", DIM, n_authors - g_top, RST);
    {
        /* Facteur bus : nb minimal d'auteurs réalisant 50% des commits. */
        int acc = 0, bus = 0;
        for (i = 0; i < n_authors && acc * 2 < n_commits; i++) { acc += authors[i].commits; bus++; }
        printf("\n");
        kv("Facteur bus (50% commits)", "%d auteur%s", bus, bus > 1 ? "s" : "");
        kv("Auteur principal", "%s %s(%.1f%% des commits)%s", authors[0].name, DIM, pct(authors[0].commits, n_commits), RST);
    }

    /* ================= ACTIVITÉ ================= */
    section("Activité par année");
    {
        int y0 = commits[first_i].y, y1 = commits[last_i].y, y;
        if (y1 < y0) { int t = y0; y0 = y1; y1 = t; }
        int ny = y1 - y0 + 1;
        long long *cnt = calloc((size_t)ny, sizeof(long long)), mx = 0;
        long long *add = calloc((size_t)ny, sizeof(long long));
        for (i = 0; i < n_commits; i++) {
            int k = commits[i].y - y0;
            if (k >= 0 && k < ny) { cnt[k]++; add[k] += commits[i].add + commits[i].del; }
        }
        for (y = 0; y < ny; y++) if (cnt[y] > mx) mx = cnt[y];
        for (y = 0; y < ny; y++) {
            printf("  %d  %7s  ", y0 + y, fnum(cnt[y]));
            bar(cnt[y], mx, 40, GRN);
            printf("  %s%s lignes%s\n", DIM, fnum(add[y]), RST);
        }
        free(cnt);
        free(add);
    }

    {
        /* Par mois : les 24 derniers mois jusqu'au dernier commit. */
        int last_m = commits[last_i].y * 12 + commits[last_i].mo - 1;
        int first_m = commits[first_i].y * 12 + commits[first_i].mo - 1;
        int start = last_m - 23 > first_m ? last_m - 23 : first_m;
        int nm = last_m - start + 1, k;
        if (nm > 0) {
            section(start > first_m ? "Activité mensuelle (24 derniers mois)" : "Activité mensuelle");
            long long *cnt = calloc((size_t)nm, sizeof(long long)), mx = 0;
            for (i = 0; i < n_commits; i++) {
                k = commits[i].y * 12 + commits[i].mo - 1 - start;
                if (k >= 0 && k < nm) cnt[k]++;
            }
            for (k = 0; k < nm; k++) if (cnt[k] > mx) mx = cnt[k];
            for (k = 0; k < nm; k++) {
                int mm = (start + k) % 12, yy = (start + k) / 12;
                printf("  %s %d  %6s  ", MONTHS[mm], yy, fnum(cnt[k]));
                bar(cnt[k], mx, 40, CYAN);
                printf("\n");
            }
            free(cnt);
        }
    }

    section("Jour de la semaine");
    {
        long long wd[7] = {0}, mx = 0;
        for (i = 0; i < n_commits; i++) wd[commits[i].wd]++;
        for (i = 0; i < 7; i++) if (wd[i] > mx) mx = wd[i];
        for (i = 0; i < 7; i++) {
            printf("  ");
            put_padded(WEEKDAYS[i], 9, 0);
            printf(" %6s %5.1f%%  ", fnum(wd[i]), pct(wd[i], n_commits));
            bar(wd[i], mx, 40, YEL);
            printf("\n");
        }
        long long we = wd[5] + wd[6];
        printf("\n");
        kv("Commits le week-end", "%.1f%%", pct(we, n_commits));
    }

    section("Heure de la journée (fuseau de l'auteur)");
    {
        long long hr[24] = {0}, mx = 0;
        for (i = 0; i < n_commits; i++) if (commits[i].h >= 0 && commits[i].h < 24) hr[commits[i].h]++;
        for (i = 0; i < 24; i++) if (hr[i] > mx) mx = hr[i];
        for (i = 0; i < 24; i++) {
            printf("  %02dh  %6s  ", i, fnum(hr[i]));
            bar(hr[i], mx, 40, MAG);
            printf("\n");
        }
        long long night = 0, office = 0;
        for (i = 0; i < 24; i++) {
            if (i < 6) night += hr[i];
            if (i >= 9 && i < 18) office += hr[i];
        }
        printf("\n");
        kv("Heures de bureau (9h-18h)", "%.1f%%", pct(office, n_commits));
        kv("Nuit (0h-6h)", "%.1f%%", pct(night, n_commits));
    }

    section("Carte de chaleur jour × heure");
    {
        static const char *shades[] = {"·", "░", "▒", "▓", "█"};
        long long hm[7][24], mx = 0;
        int d, h;
        memset(hm, 0, sizeof hm);
        for (i = 0; i < n_commits; i++)
            if (commits[i].h >= 0 && commits[i].h < 24) hm[commits[i].wd][commits[i].h]++;
        for (d = 0; d < 7; d++) for (h = 0; h < 24; h++) if (hm[d][h] > mx) mx = hm[d][h];
        printf("        ");
        for (h = 0; h < 24; h += 3) printf("%-6d", h);
        printf("\n");
        for (d = 0; d < 7; d++) {
            printf("  %.3s   ", WEEKDAYS[d]);
            for (h = 0; h < 24; h++) {
                int lvl = (int)((hm[d][h] * 4 + mx - 1) / mx);
                if (lvl > 4) lvl = 4;
                printf("%s%s%s%s", lvl ? GRN : DIM, shades[lvl], shades[lvl], RST);
            }
            printf("\n");
        }
    }

    /* ================= MESSAGES ================= */
    section("Messages de commit");
    kv("Longueur moyenne du titre", "%.1f caractères", (double)subj_len / n_commits);
    kv("Titres courts (< 10 car.)", "%s  %s(%.1f%%)%s", fnum(short_msgs), DIM, pct(short_msgs, n_commits), RST);
    {
        static const char *types[] = {"feat", "fix", "docs", "style", "refactor", "perf", "test",
                                      "build", "ci", "chore", "revert"};
        enum { NT = sizeof types / sizeof types[0] };
        long long tc[NT] = {0}, conv = 0;
        int t;
        for (i = 0; i < n_commits; i++) {
            const char *s = commits[i].subject;
            char w[16];
            int k = 0;
            while (isalpha((unsigned char)s[k]) && k < 15) { w[k] = (char)tolower((unsigned char)s[k]); k++; }
            w[k] = 0;
            const char *r = s + k;
            if (*r == '(') { r = strchr(r, ')'); if (!r) continue; r++; }
            if (*r == '!') r++;
            if (*r != ':') continue;
            for (t = 0; t < NT; t++)
                if (!strcmp(w, types[t]) || (t == 0 && !strcmp(w, "feature"))) { tc[t]++; conv++; break; }
        }
        kv("Conventional Commits", "%s  %s(%.1f%%)%s", fnum(conv), DIM, pct(conv, n_commits), RST);
        if (conv) {
            long long mx = 0;
            for (t = 0; t < NT; t++) if (tc[t] > mx) mx = tc[t];
            printf("\n");
            for (t = 0; t < NT; t++) {
                if (!tc[t]) continue;
                printf("    %-9s %6s  ", types[t], fnum(tc[t]));
                bar(tc[t], mx, 30, CYAN);
                printf("\n");
            }
        }
    }

    section("Plus gros commits");
    {
        Commit **sorted = xmalloc(sizeof(Commit *) * (size_t)n_commits);
        for (i = 0; i < n_commits; i++) sorted[i] = &commits[i];
        qsort(sorted, (size_t)n_commits, sizeof(Commit *), cmp_commit_size);
        for (i = 0; i < n_commits && i < g_top; i++) {
            Commit *c = sorted[i];
            printf("  %s%s%s  %s  %s%9s%s %s%9s%s  ", YEL, c->hash, RST, fdate(c->ts),
                   GRN, fnum(c->add), RST, RED, fnum(c->del), RST);
            printf("%s", DIM);
            put_padded(c->author_name, 18, 0);
            printf("%s  ", RST);
            put_padded(c->subject, 50, 0);
            printf("\n");
        }
        free(sorted);
    }

    /* ================= FICHIERS ================= */
    section("Fichiers les plus modifiés");
    qsort(churn, (size_t)n_churn, sizeof(Churn), cmp_churn);
    printf("  %s%8s %10s %10s  %s%s\n", BOLD, "Commits", "Ajouts", "Suppr.", "Fichier", RST);
    for (i = 0; i < n_churn && i < g_top; i++) {
        printf("  %8s %s%10s%s %s%10s%s  ", fnum(churn[i].commits), GRN, fnum(churn[i].add), RST,
               RED, fnum(churn[i].del), RST);
        put_padded(churn[i].path, 60, 0);
        printf("\n");
    }

    long long tf_lines = 0, tf_blank = 0, tf_bytes = 0, bin_bytes = 0;
    int n_bin = 0;
    for (i = 0; i < n_files; i++) {
        tf_bytes += files[i].bytes;
        if (files[i].binary) { n_bin++; bin_bytes += files[i].bytes; }
        else { tf_lines += files[i].lines; tf_blank += files[i].blank; }
    }

    section("Contenu actuel (HEAD)");
    kv("Fichiers suivis", "%s", fnum(n_files));
    kv("Fichiers texte", "%s", fnum(n_files - n_bin));
    kv("Fichiers binaires", "%s  %s(%s)%s", fnum(n_bin), DIM, fsize(bin_bytes), RST);
    kv("Lignes totales", "%s", fnum(tf_lines));
    kv("Lignes non vides", "%s", fnum(tf_lines - tf_blank));
    kv("Lignes vides", "%s  %s(%.1f%%)%s", fnum(tf_blank), DIM, pct(tf_blank, tf_lines), RST);
    kv("Taille totale", "%s", fsize(tf_bytes));

    if (n_langs) {
        section("Langages / types de fichiers");
        qsort(langs, (size_t)n_langs, sizeof(Lang), cmp_lang);
        printf("  %s%-20s %8s %10s %6s %10s%s\n", BOLD, "Langage", "Fichiers", "Lignes", "%", "Taille", RST);
        for (i = 0; i < n_langs && i < g_top + 5; i++) {
            Lang *l = &langs[i];
            printf("  ");
            put_padded(l->name, 20, 0);
            printf(" %8s %10s %5.1f%% %10s  ", fnum(l->files), fnum(l->lines), pct(l->lines, tf_lines), fsize(l->bytes));
            bar(l->lines, langs[0].lines, 25, CYAN);
            printf("\n");
        }
        if (n_langs > g_top + 5) printf("  %s... et %d autre(s)%s\n", DIM, n_langs - g_top - 5, RST);
    }

    if (n_files) {
        section("Plus gros fichiers (en lignes)");
        qsort(files, (size_t)n_files, sizeof(File), cmp_file_lines);
        for (i = 0; i < n_files && i < g_top; i++) {
            if (files[i].binary || !files[i].lines) break;
            printf("  %10s  %10s  ", fnum(files[i].lines), fsize(files[i].bytes));
            put_padded(files[i].path, 60, 0);
            printf("\n");
        }
    }
    printf("\n");
}

/* ------------------------------------------------------------------------ */
/* Export JSON / tableau de bord HTML                                       */
/* ------------------------------------------------------------------------ */

/* Le gabarit HTML est embarqué dans l'exécutable (C23 #embed, gcc >= 15,
 * clang >= 19). Sinon il est lu à l'exécution depuis dashboard.html. */
#if defined(__has_embed)
#  if __has_embed("dashboard.html")
#    define HAVE_EMBEDDED_TEMPLATE 1
static const char TEMPLATE_HTML[] = {
#    embed "dashboard.html"
};
#  endif
#endif

/* Chaîne JSON échappée, tronquée à max_chars caractères (0 = illimité). */
static void json_str(FILE *f, const char *s, int max_chars)
{
    int chars = 0;
    fputc('"', f);
    for (; *s; s++) {
        unsigned char c = (unsigned char)*s;
        if ((c & 0xC0) != 0x80) {
            if (max_chars && chars >= max_chars) { fputs("\xE2\x80\xA6", f); break; }
            chars++;
        }
        switch (c) {
        case '"': fputs("\\\"", f); break;
        case '\\': fputs("\\\\", f); break;
        case '\n': fputs("\\n", f); break;
        case '\r': fputs("\\r", f); break;
        case '\t': fputs("\\t", f); break;
        case '<': fputs("\\u003c", f); break; /* évite "</script>" dans le HTML */
        case '>': fputs("\\u003e", f); break;
        case '&': fputs("\\u0026", f); break;
        default:
            if (c < 0x20) fprintf(f, "\\u%04x", c);
            else fputc(c, f);
        }
    }
    fputc('"', f);
}

static void write_json(FILE *f, const char *name, const char *url)
{
    int i;
    long long h_lines = 0, h_blank = 0, h_bytes = 0, bin_bytes = 0;
    int n_bin = 0;
    for (i = 0; i < n_files; i++) {
        h_bytes += files[i].bytes;
        if (files[i].binary) { n_bin++; bin_bytes += files[i].bytes; }
        else { h_lines += files[i].lines; h_blank += files[i].blank; }
    }

    fputs("{\"name\":", f); json_str(f, name, 0);
    fputs(",\"url\":", f); json_str(f, url, 0);
    fputs(",\"branch\":", f); json_str(f, g_branch, 0);
    fprintf(f, ",\"generated\":%lld,\"allCommits\":%lld,\"branches\":%ld,\"tags\":%ld,\"gitSize\":%lld",
            (long long)time(NULL), g_all_commits, g_branches, g_tags, g_git_size);

    fputs(",\n\"authors\":[", f);
    for (i = 0; i < n_authors; i++) {
        fputs(i ? ",[" : "[", f);
        json_str(f, authors[i].name, 0);
        fputc(',', f);
        json_str(f, authors[i].email, 0);
        fputc(']', f);
    }

    /* [jour, heure, auteur, ajouts, suppressions, fichiers, merge, hash, sujet, timestamp] */
    fputs("],\n\"commits\":[", f);
    for (i = 0; i < n_commits; i++) {
        Commit *c = &commits[i];
        fprintf(f, "%s[%ld,%d,%d,%lld,%lld,%d,%d,\"%s\",", i ? ",\n" : "", c->day, c->h, c->author,
                c->add, c->del, c->files, c->merge, c->hash);
        json_str(f, c->subject, 120);
        fprintf(f, ",%lld]", c->ts);
    }

    qsort(churn, (size_t)n_churn, sizeof(Churn), cmp_churn);
    fputs("],\n\"churn\":[", f);
    for (i = 0; i < n_churn && i < 100; i++) {
        fputs(i ? ",[" : "[", f);
        json_str(f, churn[i].path, 0);
        fprintf(f, ",%d,%lld,%lld]", churn[i].commits, churn[i].add, churn[i].del);
    }
    fprintf(f, "],\"churnTotal\":%d", n_churn);

    fprintf(f, ",\n\"head\":{\"files\":%d,\"binary\":%d,\"binaryBytes\":%lld,\"lines\":%lld,\"blank\":%lld,\"bytes\":%lld}",
            n_files, n_bin, bin_bytes, h_lines, h_blank, h_bytes);

    qsort(langs, (size_t)n_langs, sizeof(Lang), cmp_lang);
    fputs(",\n\"langs\":[", f);
    for (i = 0; i < n_langs; i++) {
        fputs(i ? ",[" : "[", f);
        json_str(f, langs[i].name, 0);
        fprintf(f, ",%d,%lld,%lld,%lld]", langs[i].files, langs[i].lines, langs[i].blank, langs[i].bytes);
    }

    qsort(files, (size_t)n_files, sizeof(File), cmp_file_lines);
    fputs("],\n\"bigFiles\":[", f);
    int k = 0;
    for (i = 0; i < n_files && k < 100; i++) {
        if (files[i].binary) continue;
        fputs(k++ ? ",[" : "[", f);
        json_str(f, files[i].path, 0);
        fprintf(f, ",%lld,%lld]", files[i].lines, files[i].bytes);
    }
    fputs("]}\n", f);
}

/* Charge le gabarit HTML (embarqué ou depuis le disque). */
static char *load_template(size_t *len, const char *exe)
{
#ifdef HAVE_EMBEDDED_TEMPLATE
    (void)exe;
    *len = sizeof TEMPLATE_HTML;
    char *t = xmalloc(*len + 1);
    memcpy(t, TEMPLATE_HTML, *len);
    t[*len] = 0;
    return t;
#else
    char path[4096];
    const char *candidates[2];
    int c;
    snprintf(path, sizeof path, "%s", exe);
    char *slash = strrchr(path, '/'), *bs = strrchr(path, '\\');
    if (bs > slash) slash = bs;
    if (slash) strcpy(slash + 1, "dashboard.html"); else strcpy(path, "dashboard.html");
    candidates[0] = path;
    candidates[1] = "dashboard.html";
    for (c = 0; c < 2; c++) {
        FILE *f = fopen(candidates[c], "rb");
        if (!f) continue;
        fseek(f, 0, SEEK_END);
        long n = ftell(f);
        fseek(f, 0, SEEK_SET);
        char *t = xmalloc((size_t)n + 1);
        *len = fread(t, 1, (size_t)n, f);
        t[*len] = 0;
        fclose(f);
        return t;
    }
    die("gabarit dashboard.html introuvable (placez-le à côté de l'exécutable)");
    return NULL;
#endif
}

static void write_html(const char *path, const char *name, const char *url, const char *exe)
{
    static const char MARKER[] = "/*__DATA__*/null";
    size_t len;
    char *tpl = load_template(&len, exe);
    char *m = strstr(tpl, MARKER);
    if (!m) die("gabarit HTML invalide (marqueur de données absent)");
    FILE *f = fopen(path, "wb");
    if (!f) die("impossible d'écrire %s", path);
    fwrite(tpl, 1, (size_t)(m - tpl), f);
    write_json(f, name, url);
    m += sizeof MARKER - 1;
    fwrite(m, 1, len - (size_t)(m - tpl), f);
    fclose(f);
    free(tpl);
}

static void open_in_browser(const char *path)
{
    char cmd[8192];
    if (!is_shell_safe(path)) return;
#ifdef _WIN32
    snprintf(cmd, sizeof cmd, "start \"\" \"%s\"", path);
#elif defined(__APPLE__)
    snprintf(cmd, sizeof cmd, "open \"%s\"", path);
#else
    snprintf(cmd, sizeof cmd, "xdg-open \"%s\" >/dev/null 2>&1 &", path);
#endif
    if (system(cmd) != 0) fprintf(stderr, "Ouvrez le fichier dans votre navigateur : %s\n", path);
}

/* ------------------------------------------------------------------------ */
/* main                                                                     */
/* ------------------------------------------------------------------------ */

static void usage(const char *prog)
{
    printf("Usage : %s <url-git | chemin-local> [options]\n\n"
           "Exemples :\n"
           "  %s git@github.com:boykopovar/AnyPS5.git --html\n"
           "  %s https://github.com/git/git.git --top 20\n"
           "  %s ./mon-projet --html -o rapport.html\n\n"
           "Options :\n"
           "  --html       génère un tableau de bord HTML interactif et l'ouvre\n"
           "  -o FICHIER   chemin du fichier HTML (défaut : gitanalyze_<nom>.html)\n"
           "  --json F     exporte les données brutes au format JSON\n"
           "  --no-open    n'ouvre pas le navigateur\n"
           "  --top N      nombre de lignes dans les classements texte (défaut : 10)\n"
           "  --keep       conserve le clone temporaire\n"
           "  --no-color   désactive les couleurs\n",
           prog, prog, prog, prog);
}

int main(int argc, char **argv)
{
    const char *target = NULL, *html_out = NULL, *json_out = NULL;
    int keep = 0, html = 0, no_open = 0, i;

    for (i = 1; i < argc; i++) {
        if (!strcmp(argv[i], "-h") || !strcmp(argv[i], "--help")) { usage(argv[0]); return 0; }
        else if (!strcmp(argv[i], "--keep")) keep = 1;
        else if (!strcmp(argv[i], "--no-color")) g_color = 0;
        else if (!strcmp(argv[i], "--html") || !strcmp(argv[i], "--gui")) html = 1;
        else if (!strcmp(argv[i], "--no-open")) no_open = 1;
        else if (!strcmp(argv[i], "-o") && i + 1 < argc) { html_out = argv[++i]; html = 1; }
        else if (!strcmp(argv[i], "--json") && i + 1 < argc) json_out = argv[++i];
        else if (!strcmp(argv[i], "--top") && i + 1 < argc) {
            g_top = atoi(argv[++i]);
            if (g_top < 1) g_top = 1;
        } else if (argv[i][0] == '-') { usage(argv[0]); return 1; }
        else target = argv[i];
    }
    if (!target) { usage(argv[0]); return 1; }

#ifdef _WIN32
    SetConsoleOutputCP(CP_UTF8);
    if (!_isatty(_fileno(stdout))) g_color = 0;
    else {
        HANDLE h = GetStdHandle(STD_OUTPUT_HANDLE);
        DWORD mode = 0;
        if (GetConsoleMode(h, &mode)) SetConsoleMode(h, mode | 0x0004 /* VT processing */);
    }
    _putenv("GIT_TERMINAL_PROMPT=0");
#else
    if (!isatty(fileno(stdout))) g_color = 0;
    setenv("GIT_TERMINAL_PROMPT", "0", 1);
#endif

    if (!is_shell_safe(target)) die("adresse invalide (caractères interdits) : %s", target);

    char check[256];
    if (run_first_line("git --version 2>" DEVNULL, check, sizeof check) != 0 || strncmp(check, "git", 3))
        die("la commande `git` est introuvable dans le PATH");

    char dir[4096];
    int cloned = 0;
    if (is_git_repo(target)) {
        snprintf(dir, sizeof dir, "%s", target);
    } else {
        make_temp_dir(dir, sizeof dir);
        if (!is_shell_safe(dir)) die("chemin temporaire inutilisable : %s", dir);
        if (!git_clone(target, dir)) {
            char https[2048];
            if (ssh_to_https(target, https, sizeof https)) {
                fprintf(stderr, "%sÉchec en SSH, nouvel essai en HTTPS ...%s\n", YEL, RST);
                remove_dir(dir);
                make_temp_dir(dir, sizeof dir);
                if (!git_clone(https, dir)) { remove_dir(dir); die("impossible de cloner %s", target); }
            } else {
                remove_dir(dir);
                die("impossible de cloner %s", target);
            }
        }
        cloned = 1;
    }

    fprintf(stderr, "%sAnalyse de l'historique ...%s\n", DIM, RST);
    parse_log(dir);
    fprintf(stderr, "%sAnalyse des fichiers ...%s\n", DIM, RST);
    scan_files(dir);
    collect_repo_info(dir);

    /* Nom du dépôt : depuis l'URL distante si possible (cas d'un chemin "."). */
    const char *url = g_remote[0] ? g_remote : target;
    char name[256];
    repo_name(url, name, sizeof name);
    if (!name[0] || !strcmp(name, ".")) snprintf(name, sizeof name, "depot");

    if (json_out) {
        FILE *f = fopen(json_out, "wb");
        if (!f) die("impossible d'écrire %s", json_out);
        write_json(f, name, url);
        fclose(f);
        fprintf(stderr, "Données JSON écrites dans %s\n", json_out);
    }

    if (html) {
        char out[1024];
        if (html_out) snprintf(out, sizeof out, "%s", html_out);
        else {
            char safe[256];
            size_t k;
            snprintf(safe, sizeof safe, "%s", name);
            for (k = 0; safe[k]; k++)
                if (!isalnum((unsigned char)safe[k]) && !strchr("-_.", safe[k])) safe[k] = '_';
            snprintf(out, sizeof out, "gitanalyze_%s.html", safe);
        }
        write_html(out, name, url, argv[0]);
        fprintf(stderr, "%sTableau de bord écrit dans %s%s\n", GRN, out, RST);
        if (!no_open) open_in_browser(out);
    } else {
        print_report(target);
    }

    if (cloned) {
        if (keep) fprintf(stderr, "Clone conservé dans : %s\n", dir);
        else remove_dir(dir);
    }
    return 0;
}
