/**
 * SDK reporting code samples for the onboarding guide page.
 *
 * Each snippet is an excerpt from the tested examples under
 * the test cases under the repository examples folder (they really ran and landed events in
 * ClickHouse): the event JSON shape, the `data = base64(JSON array) ->
 * urlencode` form construction and the HTTP POST keep the original function
 * names, field names and encoding calls.
 *
 * - `<KEY>_DEPS`: runtime requirement plus install / compile / run commands.
 * - `<KEY>_CORE`: the minimal "report one event" excerpt; batch, retry and
 *   offline-queue details are left out and marked with a short note.
 *
 * Comments are intentionally English only: the surrounding UI copy is
 * localized by i18n, while these comments are identical for every locale
 * (13 cards would otherwise duplicate the same text in every language).
 *
 * When a language example changes, update the matching
 * snippet here in the same commit.
 */

/* ------------------------------ JavaScript (browser H5) ------------------------------ */

export const JAVASCRIPT_DEPS = String.raw`// Browser H5: zero dependency, no bundler required (UMD global ClkLog)
// <script src="./clklog.js"></script>
// ClkLog.init({ token, project }).track('PageView', { $title: 'Home' });
// Node self-check: node run-on-node.mjs  # run inside this folder`;

export const JAVASCRIPT_CORE = String.raw`// Browser H5 (UMD global ClkLog): fetch form POST (tested implementation)
// Same file: now() = Date.now(); enc(v) = encodeURIComponent(String(v)); base64(str) = pure-JS single-line base64.
ClkLog.prototype.track = function (event, properties, options) {
  var self = this;
  var opts = options || {};
  var e = {
    type: 'track',
    event: event,
    distinct_id: opts.distinctId || self._ensureDistinctId(), // anonymous id, stable after login
    time: now(),                                              // milliseconds (not seconds)
    lib: self._libInfo(),                                     // { $lib, $lib_method, $lib_version }
    properties: properties || {}
  };
  if (self.loginId !== null) {
    e.identities = { user_key: self.loginId };                // _withIdentity(): login id goes here
  }
  self._enqueue(e); // batch / retry / offline queue omitted; see the full client.
var body = ClkLog.formBody([e], self.project, self.token); // project&token&data=enc(base64(JSON.stringify(events)))
fetch(self.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
  body: body
});`;

/* ------------------------------ WeChat miniprogram ------------------------------ */

export const MINIPROGRAM_DEPS = String.raw`// WeChat miniprogram: zero dependency, wx.* built-ins only (no npm package)
// Copy clklog.js into the project: const ClkLog = require('./utils/clklog.js');
// Node self-check: node run-on-node.mjs  # run inside this folder`;

export const MINIPROGRAM_CORE = String.raw`// WeChat miniprogram: wx.request form POST (tested implementation)
// Same file: now() = Date.now(); enc(v) = encodeURIComponent(String(v)); base64(str) = pure-JS single-line base64.
ClkLog.prototype.track = function (event, properties, options) {
  var self = this;
  var opts = options || {};
  var e = {
    type: 'track',
    event: event,
    distinct_id: opts.distinctId || self._ensureDistinctId(),
    time: now(),                                   // milliseconds
    lib: self._libInfo(),
    properties: self._mergeProps(properties || {}) // merges auto-collected $os / $model / $brand
  };
  if (self.loginId !== null) {
    e.identities = { user_key: self.loginId };     // _withIdentity()
  }
  self._enqueue(e); // batch / retry omitted; see the full client.
var body = ClkLog.formBody([e], self.project, self.token); // project&token&data=enc(base64(JSON.stringify(events)))
wx.request({
  url: self.endpoint,
  method: 'POST',
  header: { 'content-type': 'application/x-www-form-urlencoded' },
  data: body, // pre-encoded string: do not let the base library serialize it again
  success: function (res) { /* res.statusCode === 200 */ }
});`;

/* ------------------------------ React Native ------------------------------ */

export const REACT_NATIVE_DEPS = String.raw`// React Native: zero npm runtime dependency (pure-JS core, inject your own storage)
// npm install @react-native-async-storage/async-storage   # optional; AsyncStorage / MMKV both work
// ClkLog.init({ token, project, storage: AsyncStorage }); clk.bindAppStateFlush(AppState);
// Node self-check: node run-on-node.mjs  # run inside this folder`;

export const REACT_NATIVE_CORE = String.raw`// React Native: global fetch form POST (tested implementation)
// Hermes has no btoa/Buffer: the file ships pure-JS base64 + encodeURIComponent form encoding.
ClkLog.prototype.track = function (event, properties, options) {
  var self = this;
  var opts = options || {};
  var e = {
    type: 'track',
    event: event,
    distinct_id: opts.distinctId || self._ensureDistinctId(),
    time: now(),                                    // milliseconds
    lib: self._libInfo(),
    properties: self._mergeProps(properties || {})  // injected systemProperties are merged in
  };
  if (self.loginId !== null) {
    e.identities = { user_key: self.loginId };      // _withIdentity()
  }
  self._enqueue(e); // batch / retry / AppState flush omitted; see the example file
};
var body = ClkLog.formBody([e], self.project, self.token); // project&token&data=enc(base64(JSON.stringify(events)))
fetch(self.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
  body: body
});`;

/* ------------------------------ Android ------------------------------ */

export const ANDROID_DEPS = String.raw`// Android: zero third-party dependency (java.net.HttpURLConnection; API 26+ for java.util.Base64)
// mkdir -p /tmp/clklog-android
// javac -encoding UTF-8 -d /tmp/clklog-android *.java && java -cp /tmp/clklog-android Main
// Production: swap postForm() for OkHttp FormBody; the protocol / queue code stays unchanged.`;

export const ANDROID_CORE = String.raw`// Android client (Java 8): HttpURLConnection form POST (tested implementation)
// Body of track(distinctId, event, properties) + flush() + postForm(); UTF8 = Charset.forName("UTF-8").
Map<String, Object> e = new LinkedHashMap<String, Object>();
e.put("type", "track");
e.put("event", "Purchase");
e.put("distinct_id", distinctId);                   // anonymous device id, stays stable after login
e.put("time", System.currentTimeMillis());          // milliseconds (not seconds)
if (userKey != null) {
    Map<String, Object> ids = new LinkedHashMap<String, Object>();
    ids.put("user_key", userKey);                   // identities(): login id goes here
    e.put("identities", ids);
}
Map<String, Object> props = new LinkedHashMap<String, Object>(); props.putAll(properties); // caller props
e.put("properties", props);
List<Map<String, Object>> batch = new ArrayList<Map<String, Object>>();
batch.add(e);                                       // queue -> JSON array; batch / retry omitted
String encoded = Base64.getEncoder().encodeToString(Json.encode(batch).getBytes(UTF8));
String body = "project=" + urlEncode(project) + "&token=" + urlEncode(token)
        + "&data=" + urlEncode(encoded);            // urlencode: base64 '+' must become %2B
HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
conn.setRequestMethod("POST");
conn.setDoOutput(true);
conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
OutputStream os = conn.getOutputStream();
os.write(body.getBytes(UTF8));
os.close();
int code = conn.getResponseCode();                  // 200 = accepted
conn.disconnect();`;

/* ------------------------------ iOS ------------------------------ */

export const IOS_DEPS = String.raw`// iOS: zero third-party dependency (Foundation URLSession; UserDefaults for the offline queue)
// swiftc -O ClkLogClient.swift main.swift -o /tmp/clklog-ios
// /tmp/clklog-ios`;

export const IOS_CORE = String.raw`// iOS (Swift + Foundation): URLSession form POST (tested implementation)
// Inside makeEvent(type:event:distinctId:properties:), buildForm(encodedData:) and postForm(_:).
var payload: [String: Any] = [
    "type": "track",
    "event": "Purchase",
    "distinct_id": deviceId(),                        // anonymous id, stable after login
    "time": Int(Date().timeIntervalSince1970 * 1000), // milliseconds
    "lib": ["$lib": ClkLogClient.lib, "$lib_method": "code", "$lib_version": ClkLogClient.libVersion],
    "properties": props
]
if let uk = currentUserKey() {
    payload["identities"] = ["user_key": uk]          // login id goes here
}
let json = try JSONSerialization.data(withJSONObject: [payload], options: [])
let form = "project=" + Self.urlEncode(project)
    + "&token=" + Self.urlEncode(token)
    + "&data=" + Self.urlEncode(json.base64EncodedString(options: [])) // single line: no .lineLength76Characters
var request = URLRequest(url: URL(string: endpoint)!)
request.httpMethod = "POST"
request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
request.httpBody = form.data(using: .utf8)
let task = session.dataTask(with: request) { data, response, error in
    let status = (response as? HTTPURLResponse)?.statusCode // 200 = accepted; retry omitted
}
task.resume()`;

/* ------------------------------ Java (server) ------------------------------ */

export const JAVA_DEPS = String.raw`// Java server (JDK 8+): zero dependency (HttpURLConnection; JDK 11+ can use java.net.http.HttpClient)
// javac -encoding UTF-8 -d /tmp/clklog-java ClkLogReport.java
// java -cp /tmp/clklog-java ClkLogReport`;

export const JAVA_CORE = String.raw`// Java server (JDK 8+): HttpURLConnection form POST (tested implementation)
// Body of track(distinctId, event, properties) + flush(); json() serializes Map / List with no dependency.
Map<String, Object> e = new LinkedHashMap<String, Object>();
e.put("type", "track");
e.put("event", "Purchase");
e.put("distinct_id", distinctId);                   // anonymous id, stays stable after login
e.put("time", System.currentTimeMillis());          // milliseconds, not seconds
if (loginId != null) {
    e.put("identities", identities(loginId));       // identities(): { "user_key": loginId }
}
e.put("lib", libIdent());
e.put("properties", properties != null ? properties : new LinkedHashMap<String, Object>());
List<Map<String, Object>> batch = new ArrayList<Map<String, Object>>();
batch.add(e);                                       // queue -> JSON array; batch / retry omitted
String json = json(batch);
String payload = Base64.getEncoder().encodeToString(json.getBytes(StandardCharsets.UTF_8));
String form = "project=" + urlEncode(project)
        + "&token=" + urlEncode(token)
        + "&data=" + urlEncode(payload);            // '+' must be %2B, else decoded as a space
HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
conn.setRequestMethod("POST");
conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
conn.setDoOutput(true);
conn.getOutputStream().write(form.getBytes(StandardCharsets.UTF_8));
int code = conn.getResponseCode();                  // 200 = accepted
conn.disconnect();`;

/* ------------------------------ Python ------------------------------ */

export const PYTHON_DEPS = String.raw`# Python 3.8+: zero dependency, standard library only (base64 / json / urllib)
# python3 report.py     # token from env CLKLOG_TOKEN`;

export const PYTHON_CORE = String.raw`# Python 3 stdlib: base64 + urlencode form POST (tested implementation)
import base64, json, time, urllib.parse, urllib.request

event_obj = {                                      # body of track(distinct_id, event, properties)
    "type": "track",
    "event": "Purchase",
    "distinct_id": distinct_id,
    "time": int(time.time() * 1000),               # milliseconds (seconds break the timeline)
    "properties": properties if properties is not None else {},
}
if login_id is not None:
    event_obj["identities"] = {"user_key": login_id}   # _with_identity()

queue = [event_obj]                                # batch / retry / backoff omitted
payload = base64.b64encode(
    json.dumps(queue, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
).decode("ascii")
body = urllib.parse.urlencode(
    {"project": project, "token": token, "data": payload}
).encode("ascii")

request = urllib.request.Request(
    endpoint, data=body, method="POST",
    headers={"Content-Type": "application/x-www-form-urlencoded", "Accept": "*/*"},
)
with urllib.request.urlopen(request, timeout=10.0) as resp:
    resp.read()                                    # HTTP 200 = accepted`;

/* ------------------------------ Node.js ------------------------------ */

export const NODEJS_DEPS = String.raw`// Node.js 18+: zero dependency (built-in fetch / URLSearchParams / Buffer)
// node report.mjs`;

export const NODEJS_CORE = String.raw`// Node.js 18+: built-in fetch form POST (tested implementation)
// Inside async track(distinctId, eventName, properties = {}) and async flush() of class ClkLogClient.
const event = {
  type: 'track',
  event: eventName,
  distinct_id: distinctId,          // anonymous id, stays stable after login
  time: Date.now(),                 // milliseconds
  properties: properties ?? {},
};
if (this.loginId !== null) {
  event.identities = { user_key: this.loginId };  // withIdentity()
}
this.enqueue(event);                // batch / retry omitted; see the example file

const payload = Buffer.from(JSON.stringify(this.queue), 'utf8').toString('base64');
const body = new URLSearchParams({
  project: this.project,
  token: this.token,
  data: payload,                    // URLSearchParams encodes the form fields
});
const resp = await fetch(this.endpoint, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: '*/*' },
  body,
  signal: AbortSignal.timeout(this.timeoutMs),
});
if (resp.status === 200) await resp.arrayBuffer(); // release the body`;

/* ------------------------------ C# (.NET 8 server) ------------------------------ */

export const CSHARP_DEPS = String.raw`// .NET 8 (dotnet SDK 8+): zero NuGet dependency (System.Net.Http + System.Text.Json)
// dotnet run   # inside your ServerReport project`;

export const CSHARP_CORE = String.raw`// .NET 8 server: HttpClient + FormUrlEncodedContent (tested implementation)
// Inside TrackAsync(); JsonOptions uses UnsafeRelaxedJsonEscaping so non-ASCII stays readable.
var e = new Dictionary<string, object?>
{
    ["type"] = "track",
    ["event"] = eventName,
    ["distinct_id"] = distinctId,
    ["time"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), // milliseconds
    ["properties"] = properties ?? new Dictionary<string, object?>(),
};
if (_loginId is not null)
{
    e["identities"] = new Dictionary<string, object?> { ["user_key"] = _loginId };
}
_queue.Add(e);   // batch / retry omitted; see the example file

var json = JsonSerializer.Serialize(_queue, JsonOptions);           // JSON array
var payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(json)); // single-line base64
using var content = new FormUrlEncodedContent(new Dictionary<string, string>
{
    ["project"] = _project,
    ["token"] = _token,
    ["data"] = payload, // FormUrlEncodedContent sets Content-Type: application/x-www-form-urlencoded
});
using var resp = await _http.PostAsync(_endpoint, content);
var code = (int)resp.StatusCode; // 200 = accepted`;

/* ------------------------------ Ruby ------------------------------ */

export const RUBY_DEPS = String.raw`# Ruby 2.6+: zero gem dependency (net/http / base64 / json are stdlib)
# ruby report.rb`;

export const RUBY_CORE = String.raw`# Ruby 2.6+ stdlib: net/http + base64 + json (tested implementation)
# Body of track / flush / post_form; now_ms = (Time.now.to_f * 1000).to_i.
event = {
  'type' => 'track',
  'event' => event_name,
  'distinct_id' => distinct_id,
  'time' => now_ms,                                              # milliseconds
  'properties' => properties || {}
}
event['identities'] = { 'user_key' => @login_id } unless @login_id.nil?  # with_identity

payload = Base64.strict_encode64(JSON.generate([event]))         # strict: encode64 would insert line breaks
body = URI.encode_www_form('project' => @project, 'token' => @token, 'data' => payload)

uri = URI.parse(@endpoint)
http = Net::HTTP.new(uri.host, uri.port)
http.use_ssl = (uri.scheme == 'https')
request = Net::HTTP::Post.new(uri.request_uri)
request['Content-Type'] = 'application/x-www-form-urlencoded'
request.body = body
response = http.request(request)                                 # response.code.to_i == 200`;

/* ------------------------------ C (C11 + libcurl) ------------------------------ */

export const C_DEPS = String.raw`// C11 + libcurl
// macOS: SDK=$(xcrun --show-sdk-path) && cc -std=c11 -O2 -I"$SDK/usr/include" -o /tmp/clklog-c/clklog_report clklog_report.c -L"$SDK/usr/lib" -lcurl
// Linux: sudo apt install libcurl4-openssl-dev && cc -std=c11 -O2 -o clklog_report clklog_report.c -lcurl
// Run: CLKLOG_ENDPOINT=... CLKLOG_TOKEN=... /tmp/clklog-c/clklog_report`;

export const C_CORE = String.raw`/* C11 + libcurl: event JSON, base64 + urlencode form, POST (tested implementation) */
/* build_event(): time is milliseconds; the login id goes to identities.user_key. */
sbuf b; sb_init(&b);
sb_puts(&b, "{\"type\":\"track\",\"event\":"); json_str_to(&b, "Purchase");
sb_puts(&b, ",\"distinct_id\":");
json_str_to(&b, distinct_id);
sb_putf(&b, ",\"time\":%lld", clklog_now_ms());   /* milliseconds */
if (user_key && *user_key) {
    sb_puts(&b, ",\"identities\":{\"user_key\":");
    json_str_to(&b, user_key);
    sb_puts(&b, "}");
}
sb_puts(&b, ",\"properties\":{}}");
sbuf body, b64, form;   /* clklog_flush(): queue -> JSON array -> base64 (single line) -> urlencode -> POST */
sb_putc(&body, '[');
for (i = 0; i < n; i++) { if (i) sb_putc(&body, ','); sb_puts(&body, c->queue[i]); }
sb_putc(&body, ']');
base64_to(&b64, (const unsigned char *)body.data, body.len);
sb_puts(&form, "project=");  url_encode_to(&form, c->project, strlen(c->project));
sb_puts(&form, "&token=");   url_encode_to(&form, c->token, strlen(c->token));
sb_puts(&form, "&data=");    url_encode_to(&form, b64.data, b64.len);  /* '+' -> %2B */
curl_easy_setopt(c->curl, CURLOPT_URL, c->endpoint);
curl_easy_setopt(c->curl, CURLOPT_POST, 1L);
curl_easy_setopt(c->curl, CURLOPT_POSTFIELDS, form.data);
curl_easy_setopt(c->curl, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)form.len);
curl_easy_setopt(c->curl, CURLOPT_HTTPHEADER, c->headers); /* Content-Type: application/x-www-form-urlencoded */
curl_easy_perform(c->curl);   /* batch / retry omitted; see the example file */`;

/* ------------------------------ C++ (C++17 + libcurl) ------------------------------ */

export const CPP_DEPS = String.raw`// C++17 + libcurl
// macOS: SDK=$(xcrun --show-sdk-path) && clang++ -std=c++17 -O2 -I"$SDK/usr/include" -o /tmp/clklog-cpp/clklog_report clklog_report.cpp -L"$SDK/usr/lib" -lcurl
// Linux: sudo apt install libcurl4-openssl-dev libssl-dev && clang++ -std=c++17 -O2 -o clklog_report clklog_report.cpp -lcurl
// Run: CLKLOG_ENDPOINT=... CLKLOG_TOKEN=... /tmp/clklog-cpp/clklog_report`;

export const CPP_CORE = String.raw`// C++17 + libcurl: Event::toJson(), Client::flush(), HttpTransport::post() (tested implementation)
std::string j = "{\"type\":" + jsonString(type);
if (!event.empty()) {
    j += ",\"event\":" + jsonString(event);
}
j += ",\"distinct_id\":" + jsonString(distinctId);
j += ",\"time\":" + std::to_string(timeMs);       // nowMs(): milliseconds
if (!userKey.empty()) {
    j += ",\"identities\":{\"user_key\":" + jsonString(userKey) + "}";
}
j += ",\"lib\":{\"$lib\":\"" + kLib + "\",\"$lib_version\":\"" + kLibVersion + "\"}";
j += ",\"properties\":" + properties;             // empty properties must still be "{}"

std::string json = "[";
for (std::size_t i = 0; i < n; i++) { if (i != 0) json += ','; json += queue_[i].toJson(); }
json += ']';
const std::string payload = base64(json);         // strictly single-line base64
const std::string form = "project=" + urlEncode(project_) +
                         "&token=" + urlEncode(token_) +
                         "&data=" + urlEncode(payload);  // '+' -> %2B
curl_easy_setopt(curl_, CURLOPT_URL, endpoint_.c_str());
curl_easy_setopt(curl_, CURLOPT_POST, 1L);
curl_easy_setopt(curl_, CURLOPT_POSTFIELDS, form.data());
curl_easy_setopt(curl_, CURLOPT_POSTFIELDSIZE_LARGE, static_cast<curl_off_t>(form.size()));
curl_easy_setopt(curl_, CURLOPT_HTTPHEADER, headers_); /* Content-Type: application/x-www-form-urlencoded */
curl_easy_perform(curl_);   // batch / retry omitted; see the example file`;


/* ------------------------------ Flutter / Dart ------------------------------ */

export const FLUTTER_DEPS = String.raw`// Dart 3.8+ / Flutter 3.x, dependency: http (pubspec.yaml)
// flutter pub get
// dart run run_dart.dart      # CLI smoke test, prints DONE run_id = flutter-<ts>
// flutter build web --release # platform build (no Xcode/Android SDK needed)`;

export const FLUTTER_CORE = String.raw`// Dart: strict percent-encoding + form POST (excerpt from lib/clklog.dart)
// Note: Dart string interpolation is written as concatenation here so the snippet
// can live inside a docs template literal; the logic matches the real client.
/// Only unreserved characters stay as-is. Unlike Uri.encodeFull (keeps + / =)
/// and Uri.encodeQueryComponent (maps space to +), base64's + / padding = must
/// become %2B / %3D, otherwise the receiver decodes + as space and drops the batch.
String percentEncodeStrict(String input) {
  const unreserved = 'A-Za-z0-9-_.~';
  final out = StringBuffer();
  for (final byte in utf8.encode(input)) {
    final ch = String.fromCharCode(byte);
    out.write(unreserved.contains(ch)
        ? ch
        : '%' + byte.toRadixString(16).padLeft(2, '0').toUpperCase());
  }
  return out.toString();
}

String encodeData(List<Map<String, Object?>> events) =>
    percentEncodeStrict(base64.encode(utf8.encode(jsonEncode(events))));

Future<void> flush() async {
  final event = <String, Object?>{
    'type': 'track',
    'event': 'Purchase',
    'distinct_id': deviceId,            // anonymous id, unchanged after login
    'time': DateTime.now().millisecondsSinceEpoch,   // milliseconds
    'properties': props,
    if (loginId != null) 'identities': {'user_key': loginId},  // login id lives here
  };
  final body = 'project=' + percentEncodeStrict(project)
      + '&token=' + percentEncodeStrict(token)
      + '&data=' + encodeData([event]);
  assertNoRawPlusOrEquals(body);   // fail locally instead of silently losing data
  final res = await http.post(Uri.parse(endpoint), headers: {
    'Content-Type': 'application/x-www-form-urlencoded',
  }, body: body);
  if (res.statusCode != 200) throw ClkLogException('http ' + res.statusCode.toString());
  // batch / retry / offline queue omitted; see the full client.
`;


/* ------------------------------ 批量回补（文件导入 CLI） ------------------------------ */

export const BATCH_IMPORT_CSV = String.raw`type,event,distinct_id,time,user_key,original_id,order_id,amount,pay_type
track,SdkSpecTest,sdk-test-anon-history-001,1785228036000,,,,,
track,ViewProduct,sdk-test-anon-history-001,1785228090000,,,P1001,,
track_signup,$SignUp,user_9527,1785228200000,user_9527,sdk-test-anon-history-001,,,
user_set,,sdk-test-anon-history-001,1785228250000,user_9527,,,,,
track,Purchase,sdk-test-anon-history-001,1785228300000,user_9527,,O20260915001,99.5,alipay

# Required columns: type / event / distinct_id / time (milliseconds or a parseable time string)
# user_key    -> identities.user_key (login id)
# original_id -> properties.$track_signup_original_id (binds the anonymous id on track_signup);
#                aliases: $track_signup_original_id / track_signup_original_id / signup_original_id
# other columns -> properties (a $ prefix marks a preset property); properties_json merges a JSON object`;

export const BATCH_IMPORT_CMD = String.raw`# 1) dry run: validates encoding and sizes, sends nothing
python3 backfill.py --input history.csv --limit 5 --dry-run

# 2) small real batch, prints the run id
python3 backfill.py --input history.csv --limit 100 --rate 50

# 3) full backfill (resumable; progress in <input>.backfill-progress.json)
python3 backfill.py --input history.csv --resume

# common flags
#   --format csv|jsonl     input format (guessed from the extension by default)
#   --batch-size 50        events per request (protocol cap 50; bigger batches are split)
#   --rate 0               throttle in events/second, 0 = unlimited
#   --run-id <id>          force the run id (default backfill-<unix seconds>)
#   --force-resume         resume even if the input file changed (dangerous, refused by default)`;

export const BATCH_IMPORT_VERIFY = String.raw`SELECT typeContext, event, count() AS rows
FROM clklog.log_analysis
WHERE distinct_id LIKE '%<run_id>%'
GROUP BY typeContext, event
ORDER BY rows DESC;`;

/* ------------------------------ Lua ------------------------------ */

export const LUA_DEPS = String.raw`-- Lua 5.4+ / 5.5 with luasocket + luasec (HTTPS)
-- brew install lua luarocks && luarocks install luasocket
-- luarocks install luasec OPENSSL_DIR="$(brew --prefix openssl@3)"
-- lua report.lua`;

export const LUA_CORE = String.raw`-- Lua 5.4+ (luasocket + luasec): form POST (tested implementation)
-- Client:track() and Client:flush(); as_object / as_array keep empty tables typed, M.base64 is single-line.
local event = {
  type = "track",
  event = "Purchase",
  distinct_id = self.device_id,
  time = M.now_ms(),                           -- milliseconds (socket.gettime, not os.time)
  identities = self.user_key and as_object({ user_key = self.user_key }) or nil,
  lib = as_object({ ["$lib"] = self.lib, ["$lib_version"] = self.lib_version }),
  properties = as_object(props),
}
self.queue[#self.queue + 1] = event

local batch = as_array({})
for i, e in ipairs(self.queue) do batch[i] = e end
local data = M.base64(encode(batch))           -- single line (the implementation asserts no CR/LF)
local fields = { project = self.project, token = self.token, data = data }

local parts = {}
for k, v in pairs(fields) do
  parts[#parts + 1] = M.url_encode(k) .. "=" .. M.url_encode(v)   -- '+' -> %2B
end
local body = table.concat(parts, "&")
local params = { url = self.endpoint, method = "POST", source = ltn12.source.string(body),
  headers = { ["Content-Type"] = "application/x-www-form-urlencoded" } }
local ok, code = https.request(params)          -- code == 200; batch / retry omitted`;

/* ------------------------------ Card lookup ------------------------------ */

/** Card key (as used by `sdk-guides.ts`) -> the two snippets shown on that card. */
export const SDK_CODE_SAMPLES = {
  javascript: { deps: JAVASCRIPT_DEPS, core: JAVASCRIPT_CORE },
  miniprogram: { deps: MINIPROGRAM_DEPS, core: MINIPROGRAM_CORE },
  'react-native': { deps: REACT_NATIVE_DEPS, core: REACT_NATIVE_CORE },
  android: { deps: ANDROID_DEPS, core: ANDROID_CORE },
  ios: { deps: IOS_DEPS, core: IOS_CORE },
  java: { deps: JAVA_DEPS, core: JAVA_CORE },
  python: { deps: PYTHON_DEPS, core: PYTHON_CORE },
  nodejs: { deps: NODEJS_DEPS, core: NODEJS_CORE },
  csharp: { deps: CSHARP_DEPS, core: CSHARP_CORE },
  ruby: { deps: RUBY_DEPS, core: RUBY_CORE },
  c: { deps: C_DEPS, core: C_CORE },
  cpp: { deps: CPP_DEPS, core: CPP_CORE },
  lua: { deps: LUA_DEPS, core: LUA_CORE },
  flutter: { deps: FLUTTER_DEPS, core: FLUTTER_CORE },
} as const;

export type SdkCodeKey = keyof typeof SDK_CODE_SAMPLES;
