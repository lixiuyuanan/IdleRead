package com.ldleread.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

/**
 * 多源、多线程、可暂停续传的分块下载器。
 *
 * <p>做四件事：</p>
 * <ol>
 *   <li><b>测速选源</b>：候选镜像（含直连）并发各拉一小段，按实测速度排序。
 *       镜像能不能用、快不快跟用户网络强相关，写死「最快镜像」没有意义。</li>
 *   <li><b>多源并发</b>：文件切成小分块进任务队列，多个 worker 抢块，不同 worker 走不同镜像，
 *       单镜像被限速时总带宽还能叠起来。慢源拖不动全局，因为它拿到的块本来就少。</li>
 *   <li><b>逐块核对</b>：每块都核对 Content-Range 的总长度与实收字节数，不一致就换源重拉这一块，
 *       不让脏数据写进文件。整包下完还要过 SHA-256，不一致会自动用单一源重下一遍。</li>
 *   <li><b>暂停 / 续传</b>：已完成的块记在 {@code <目标>.part} 里，暂停或进程被杀之后能接着下，
 *       不用从 0 重来。</li>
 * </ol>
 */
public final class RangeDownloader {

    public interface Listener {
        /** 测速结束：存活几个源、最快的是谁。已在后台线程调用。 */
        void onProbe(int alive, String best);

        void onProgress(long done, long total);

        /** 用户暂停了；已下载的部分保留着，可以续传。 */
        void onPause(long done, long total);

        void onDone(File file);

        void onError(String message);
    }

    private static final String UA =
            "Mozilla/5.0 (Linux; Android 12; IdleRead) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36";
    private static final int MAX_REDIRECT = 6;
    private static final int BUFFER = 65536;
    private static final int PROBE_BYTES = 96 * 1024;
    private static final int PROBE_WAIT_MS = 6000;
    private static final long MIN_CHUNK = 256 * 1024L;
    private static final int MAX_WORKERS = 8;
    private static final int MAX_RETRY = 4;

    private static volatile boolean cancelled = false;
    private static volatile boolean paused = false;
    private static volatile long lastReport = 0L;
    private static volatile Thread worker = null;
    private static final Object STATE_LOCK = new Object();

    private RangeDownloader() {
    }

    public static boolean busy() {
        Thread t = worker;
        return t != null && t.isAlive();
    }

    /** 真放弃：线程停掉、半成品删掉。 */
    public static void cancel() {
        cancelled = true;
        paused = false;
        stopWorker();
    }

    /** 暂停：线程停掉，但文件与进度留着，下次 start(resume=true) 接着下。 */
    public static void pause() {
        Thread t = worker;
        if (t == null || !t.isAlive()) return;
        paused = true;
        stopWorker();
    }

    private static void stopWorker() {
        Thread t = worker;
        if (t != null) t.interrupt();
        worker = null;
    }

    /**
     * @param rawUrl   不带任何镜像前缀的原始地址
     * @param prefixes 镜像前缀数组，"" 表示直连；为空则只走直连
     * @param resume   是否尝试续传（有可用的 .part 就从断点接着下）
     * @param single   只用第一个可用源（SHA 不一致时用来重下一遍，排除镜像内容不一致的可能）
     */
    public static void start(final String rawUrl, final String[] prefixes, final File target,
                             final boolean resume, final boolean single, final Listener listener) {
        stopWorker();
        cancelled = false;
        paused = false;
        lastReport = 0L;
        Thread t = new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    RangeDownloader.run(rawUrl, prefixes, target, resume, single, listener);
                } catch (Throwable e) {
                    if (cancelled || paused) return;
                    deleteQuietly(target);
                    deleteQuietly(stateFile(target));
                    safeError(listener, message(e));
                }
            }
        }, "range-download");
        t.setDaemon(true);
        worker = t;
        t.start();
    }

    /* ---------------- 主流程 ---------------- */

    private static void run(String rawUrl, String[] prefixes, File target,
                            boolean resume, boolean single, Listener listener) throws Exception {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) parent.mkdirs();

        List<Source> alive = probe(rawUrl, prefixes, listener);
        if (alive.isEmpty()) {
            throw new Exception("所有下载源都连不上，换个网络再试");
        }

        List<Source> ranged = new ArrayList<Source>();
        for (Source s : alive) {
            if (s.ranged && s.total > 0) ranged.add(s);
        }
        if (single && ranged.size() > 1) {
            ranged = new ArrayList<Source>(ranged.subList(0, 1));
        }

        if (ranged.isEmpty()) {
            // 没有一个源支持 Range：只能整份重拉，不支持暂停续传。
            deleteQuietly(target);
            deleteQuietly(stateFile(target));
            streamToFile(alive.get(0).prefix + rawUrl, target, alive.get(0).total, listener);
            if (cancelled) return;
            if (paused) {
                deleteQuietly(target);
                safePause(listener, 0, 0);
                return;
            }
            safeReport(listener, target.length(), target.length(), true);
            safeDone(listener, target);
            return;
        }

        final long total = ranged.get(0).total;
        final String partUrl = rawUrl;
        final List<Source> sources = ranged;

        // 目标 40~60 块：太小握手开销占比高，太大慢源拖后腿。
        long chunkSize = Math.max(MIN_CHUNK, total / 48);
        final long chunk = chunkSize;
        final int chunkCount = (int) ((total + chunkSize - 1) / chunkSize);

        // 续传：状态文件里的 url / total / chunk 三者都对得上才认。
        Set<Integer> finished = new HashSet<Integer>();
        if (resume) finished = loadState(target, partUrl, total, chunkSize);
        boolean canResume = !finished.isEmpty() && target.exists() && target.length() == total;

        final FileChannel channel;
        RandomAccessFile raf = new RandomAccessFile(target, "rw");
        channel = raf.getChannel();
        if (!canResume) {
            finished.clear();
            channel.truncate(0);
            raf.setLength(total);
        }

        final boolean[] doneFlags = new boolean[chunkCount];
        for (Integer index : finished) {
            if (index >= 0 && index < chunkCount) doneFlags[index] = true;
        }

        final AtomicInteger cursor = new AtomicInteger(0);
        final AtomicLong done = new AtomicLong(completedBytes(doneFlags, chunk, total));
        final List<String> errors = Collections.synchronizedList(new ArrayList<String>());
        final long grandTotal = total;
        final int chunks = chunkCount;

        int workers = Math.min(MAX_WORKERS, Math.max(2, sources.size() * 2));
        workers = Math.min(workers, chunkCount);

        List<Thread> pool = new ArrayList<Thread>();
        for (int i = 0; i < workers; i++) {
            final int slot = i;
            Thread part = new Thread(new Runnable() {
                @Override
                public void run() {
                    while (!cancelled && !paused) {
                        int index = cursor.getAndIncrement();
                        if (index >= chunks) return;
                        if (doneFlags[index]) continue;          // 续传时跳过已完成块
                        long from = (long) index * chunk;
                        long to = Math.min(grandTotal - 1, from + chunk - 1);
                        try {
                            fetchChunk(partUrl, sources, slot, from, to,
                                    channel, done, grandTotal, listener);
                            doneFlags[index] = true;
                            saveState(target, partUrl, grandTotal, chunk, doneFlags);
                        } catch (Throwable e) {
                            errors.add(message(e));
                            return;
                        }
                    }
                }
            }, "range-part-" + i);
            part.setDaemon(true);
            pool.add(part);
            part.start();
        }

        for (Thread part : pool) {
            try {
                part.join();
            } catch (InterruptedException e) {
                // pause()/cancel() 会打断，循环里靠标志位收尾
            }
        }
        try { channel.close(); } catch (Exception ignored) { }
        try { raf.close(); } catch (Exception ignored) { }

        if (cancelled) {
            deleteQuietly(target);
            deleteQuietly(stateFile(target));
            return;
        }
        if (paused) {
            saveState(target, partUrl, grandTotal, chunk, doneFlags);
            safePause(listener, done.get(), grandTotal);
            return;
        }
        if (!errors.isEmpty()) {
            deleteQuietly(target);
            deleteQuietly(stateFile(target));
            throw new Exception(errors.get(0));
        }
        if (target.length() != total) {
            deleteQuietly(target);
            deleteQuietly(stateFile(target));
            throw new Exception("下载不完整");
        }
        deleteQuietly(stateFile(target));
        safeReport(listener, total, total, true);
        safeDone(listener, target);
    }

    private static long completedBytes(boolean[] flags, long chunk, long total) {
        long sum = 0;
        for (int i = 0; i < flags.length; i++) {
            if (!flags[i]) continue;
            long from = (long) i * chunk;
            long to = Math.min(total - 1, from + chunk - 1);
            sum += (to - from + 1);
        }
        return sum;
    }

    /* ---------------- 断点状态（纯文本，别引入 JSON 依赖） ---------------- */

    private static File stateFile(File target) {
        return new File(target.getAbsolutePath() + ".part");
    }

    private static void saveState(File target, String url, long total, long chunk, boolean[] flags) {
        synchronized (STATE_LOCK) {
            StringBuilder builder = new StringBuilder();
            builder.append("total=").append(total).append('\n');
            builder.append("chunk=").append(chunk).append('\n');
            builder.append("url=").append(url).append('\n');
            builder.append("done=");
            boolean first = true;
            for (int i = 0; i < flags.length; i++) {
                if (!flags[i]) continue;
                if (!first) builder.append(',');
                builder.append(i);
                first = false;
            }
            builder.append('\n');
            FileOutputStream output = null;
            try {
                output = new FileOutputStream(stateFile(target));
                output.write(builder.toString().getBytes("UTF-8"));
                output.flush();
            } catch (Exception ignored) {
            } finally {
                if (output != null) {
                    try { output.close(); } catch (Exception ignored) { }
                }
            }
        }
    }

    private static Set<Integer> loadState(File target, String url, long total, long chunk) {
        Set<Integer> out = new HashSet<Integer>();
        File file = stateFile(target);
        if (!file.exists()) return out;
        InputStream input = null;
        try {
            input = new FileInputStream(file);
            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] block = new byte[4096];
            int read;
            while ((read = input.read(block)) != -1) buffer.write(block, 0, read);
            String text = new String(buffer.toByteArray(), "UTF-8");
            long savedTotal = -1L;
            long savedChunk = -1L;
            String savedUrl = "";
            String savedDone = "";
            String[] lines = text.split("\n");
            for (String line : lines) {
                int eq = line.indexOf('=');
                if (eq <= 0) continue;
                String key = line.substring(0, eq).trim();
                String value = line.substring(eq + 1).trim();
                if ("total".equals(key)) savedTotal = parseLong(value, -1L);
                else if ("chunk".equals(key)) savedChunk = parseLong(value, -1L);
                else if ("url".equals(key)) savedUrl = value;
                else if ("done".equals(key)) savedDone = value;
            }
            if (savedTotal != total || savedChunk != chunk || !url.equals(savedUrl)) return out;
            if (!savedDone.isEmpty()) {
                String[] parts = savedDone.split(",");
                for (String part : parts) {
                    long index = parseLong(part.trim(), -1L);
                    if (index >= 0) out.add((int) index);
                }
            }
        } catch (Exception ignored) {
        } finally {
            if (input != null) {
                try { input.close(); } catch (Exception ignored) { }
            }
        }
        return out;
    }

    private static long parseLong(String text, long fallback) {
        try {
            return Long.parseLong(text);
        } catch (Exception e) {
            return fallback;
        }
    }

    /* ---------------- 测速 ---------------- */

    private static final class Source {
        final String prefix;
        boolean ranged;
        boolean dead;
        long speed;
        long total = -1;

        Source(String prefix) {
            this.prefix = prefix;
        }

        String label() {
            if (prefix == null || prefix.isEmpty()) return "直连 GitHub";
            String text = prefix;
            int cut = text.indexOf("://");
            if (cut > 0) text = text.substring(cut + 3);
            while (text.endsWith("/")) text = text.substring(0, text.length() - 1);
            return text;
        }
    }

    private static List<Source> probe(final String rawUrl, String[] prefixes, Listener listener) {
        List<Source> list = new ArrayList<Source>();
        if (prefixes != null) {
            for (String prefix : prefixes) {
                if (prefix == null) continue;
                list.add(new Source(prefix.trim()));
            }
        }
        if (list.isEmpty()) list.add(new Source(""));

        final CountDownLatch latch = new CountDownLatch(list.size());
        ExecutorService pool = Executors.newFixedThreadPool(Math.min(8, list.size()));
        for (final Source source : list) {
            pool.execute(new Runnable() {
                @Override
                public void run() {
                    try {
                        measure(source, rawUrl);
                    } catch (Throwable e) {
                        source.dead = true;
                    } finally {
                        latch.countDown();
                    }
                }
            });
        }
        try {
            latch.await(PROBE_WAIT_MS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ignored) {
            cancelled = true;
        }
        pool.shutdownNow();

        List<Source> out = new ArrayList<Source>();
        for (Source source : list) {
            if (!source.dead && source.speed > 0) out.add(source);
        }
        Collections.sort(out, new Comparator<Source>() {
            @Override
            public int compare(Source a, Source b) {
                if (a.ranged != b.ranged) return a.ranged ? -1 : 1;
                if (b.speed > a.speed) return 1;
                if (b.speed < a.speed) return -1;
                return 0;
            }
        });
        if (listener != null) {
            try {
                listener.onProbe(out.size(), out.isEmpty() ? "" : out.get(0).label());
            } catch (Throwable ignored) { }
        }
        return out;
    }

    private static void measure(Source source, String rawUrl) {
        long start = System.currentTimeMillis();
        HttpURLConnection connection = null;
        InputStream input = null;
        try {
            connection = open(source.prefix + rawUrl, "bytes=0-" + (PROBE_BYTES - 1));
            int code = connection.getResponseCode();
            if (code == 206) {
                source.ranged = true;
                long[] range = parseContentRange(connection.getHeaderField("Content-Range"));
                if (range != null) source.total = range[2];
            } else if (code == 200) {
                source.ranged = false;
                source.total = connection.getContentLength();
            } else {
                source.dead = true;
                return;
            }
            input = connection.getInputStream();
            long got = 0;
            byte[] buffer = new byte[16384];
            while (got < PROBE_BYTES) {
                int read = input.read(buffer);
                if (read < 0) break;
                got += read;
                if (System.currentTimeMillis() - start > PROBE_WAIT_MS) break;
            }
            long cost = Math.max(1L, System.currentTimeMillis() - start);
            source.speed = got * 1000L / cost;
            if (got <= 0) source.dead = true;
        } catch (Throwable e) {
            source.dead = true;
        } finally {
            if (input != null) {
                try { input.close(); } catch (Exception ignored) { }
            }
            if (connection != null) {
                try { connection.disconnect(); } catch (Exception ignored) { }
            }
        }
    }

    /* ---------------- 单块：逐块核对，坏了换源重拉 ---------------- */

    private static void fetchChunk(String rawUrl, List<Source> sources, int slot,
                                   long from, long to, FileChannel channel,
                                   AtomicLong done, long total, Listener listener) throws Exception {
        long pos = from;
        long need = to - from + 1;
        int attempt = 0;
        byte[] buffer = new byte[BUFFER];
        while (pos <= to) {
            if (cancelled || paused) return;
            Source source = sources.get((slot + attempt) % sources.size());
            HttpURLConnection connection = null;
            InputStream input = null;
            try {
                connection = open(source.prefix + rawUrl, "bytes=" + pos + "-" + to);
                int code = connection.getResponseCode();
                if (code != 206) throw new Exception("分块被拒绝 HTTP " + code);
                // 逐块核对：这个源对同一文件报的总长必须和我们算的一致，
                // 否则它多半缓存了别的版本，拼进来就是脏数据。
                long[] range = parseContentRange(connection.getHeaderField("Content-Range"));
                if (range != null && range[2] > 0 && range[2] != total) {
                    throw new Exception("源内容长度不一致");
                }
                input = connection.getInputStream();
                long got = 0;
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (cancelled || paused) return;
                    int take = read;
                    if (pos + take > to + 1) take = (int) (to + 1 - pos);
                    if (take <= 0) break;
                    channel.write(ByteBuffer.wrap(buffer, 0, take), pos);
                    pos += take;
                    got += take;
                    safeReport(listener, done.addAndGet(take), total, false);
                }
                if (got < need) {
                    // 提前断流：不认，换源从断点接着拉。
                    need -= got;
                    attempt++;
                    if (attempt > MAX_RETRY) throw new Exception("下载断流");
                    continue;
                }
                need = 0;
            } catch (Exception e) {
                attempt++;
                if (cancelled || paused) return;
                if (attempt > MAX_RETRY) throw e;
                try {
                    Thread.sleep(400L * attempt);
                } catch (InterruptedException ignored) {
                    return;
                }
            } finally {
                if (input != null) {
                    try { input.close(); } catch (Exception ignored) { }
                }
                if (connection != null) {
                    try { connection.disconnect(); } catch (Exception ignored) { }
                }
            }
        }
    }

    /* ---------------- 单连接流式（没有源支持 Range 时） ---------------- */

    private static void streamToFile(String url, File target, long total,
                                     Listener listener) throws Exception {
        HttpURLConnection connection = null;
        InputStream input = null;
        FileOutputStream output = null;
        try {
            connection = open(url, null);
            int code = connection.getResponseCode();
            if (code != 200 && code != 206) throw new Exception("服务器返回 " + code);
            if (total <= 0) total = connection.getContentLength();
            input = connection.getInputStream();
            output = new FileOutputStream(target);
            long done = 0L;
            byte[] buffer = new byte[BUFFER];
            int read;
            while ((read = input.read(buffer)) != -1) {
                if (cancelled || paused) return;
                output.write(buffer, 0, read);
                done += read;
                safeReport(listener, done, total, false);
            }
            output.flush();
        } finally {
            if (input != null) {
                try { input.close(); } catch (Exception ignored) { }
            }
            if (output != null) {
                try { output.close(); } catch (Exception ignored) { }
            }
            if (connection != null) {
                try { connection.disconnect(); } catch (Exception ignored) { }
            }
        }
    }

    /* ---------------- HTTP ---------------- */

    private static HttpURLConnection open(String url, String range) throws Exception {
        String current = url;
        for (int hop = 0; hop < MAX_REDIRECT; hop++) {
            HttpURLConnection connection = (HttpURLConnection) new URL(current).openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(10000);
            connection.setReadTimeout(25000);
            connection.setUseCaches(false);
            connection.setRequestProperty("User-Agent", UA);
            // 关键：不加 identity 的话 CDN 可能回 gzip，Content-Length 和字节区间都会错位。
            connection.setRequestProperty("Accept-Encoding", "identity");
            if (range != null) connection.setRequestProperty("Range", range);
            int code = connection.getResponseCode();
            if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || location.isEmpty()) throw new Exception("跳转地址丢了");
                if (location.startsWith("/")) {
                    URL base = new URL(current);
                    int port = base.getPort();
                    location = base.getProtocol() + "://" + base.getHost()
                            + (port > 0 ? ":" + port : "") + location;
                }
                current = location;
                continue;
            }
            return connection;
        }
        throw new Exception("跳转太多次");
    }

    private static long[] parseContentRange(String value) {
        // bytes 0-0/38045977
        if (value == null) return null;
        int slash = value.lastIndexOf('/');
        if (slash < 0) return null;
        String tail = value.substring(slash + 1).trim();
        if (tail.isEmpty() || "*".equals(tail)) return null;
        try {
            return new long[]{0L, 0L, Long.parseLong(tail)};
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /* ---------------- 小工具 ---------------- */

    private static void safeReport(Listener listener, long done, long total, boolean force) {
        if (listener == null) return;
        long now = System.currentTimeMillis();
        if (!force && now - lastReport < 180L) return;
        lastReport = now;
        try {
            listener.onProgress(done, total);
        } catch (Throwable ignored) { }
    }

    private static void safePause(Listener listener, long done, long total) {
        if (listener == null) return;
        try {
            listener.onPause(done, total);
        } catch (Throwable ignored) { }
    }

    private static void safeDone(Listener listener, File file) {
        if (listener == null) return;
        try {
            listener.onDone(file);
        } catch (Throwable ignored) { }
    }

    private static void safeError(Listener listener, String message) {
        if (listener == null) return;
        try {
            listener.onError(message);
        } catch (Throwable ignored) { }
    }

    private static String message(Throwable e) {
        String text = e.getMessage();
        if (text == null || text.isEmpty()) text = e.getClass().getSimpleName();
        return text;
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            try { file.delete(); } catch (Exception ignored) { }
        }
    }
}
