using System.Text;
using System.Text.RegularExpressions;

namespace EFViz;

/// <summary>
/// Minimal C# lexing helpers — a direct port of src/csharp.js from the npm CLI.
/// EF Core's generated designer/snapshot files are so regular that string-aware
/// scanning of balanced delimiters and fluent chains is all we need.
/// </summary>
public static class CSharpLex
{
    /// <summary>Remove // and /* */ comments while preserving string literals.</summary>
    public static string StripComments(string code)
    {
        var sb = new StringBuilder(code.Length);
        var i = 0;
        var n = code.Length;
        while (i < n)
        {
            var c = code[i];
            var next = i + 1 < n ? code[i + 1] : '\0';
            if (c == '/' && next == '/')
            {
                while (i < n && code[i] != '\n') i++;
                continue;
            }
            if (c == '/' && next == '*')
            {
                i += 2;
                while (i + 1 < n && !(code[i] == '*' && code[i + 1] == '/')) i++;
                i = Math.Min(i + 2, n);
                continue;
            }
            if (c == '"' || ((c == '@' || c == '$') && next == '"'))
            {
                var start = i;
                i = SkipString(code, i);
                sb.Append(code, start, i - start);
                continue;
            }
            if (c == '\'')
            {
                var start = i;
                i++;
                while (i < n && code[i] != '\'')
                {
                    if (code[i] == '\\') i++;
                    i++;
                }
                i++;
                sb.Append(code, start, Math.Min(i, n) - start);
                continue;
            }
            sb.Append(c);
            i++;
        }
        return sb.ToString();
    }

    /// <summary>Given index at the start of a string literal, return index just past its end.</summary>
    public static int SkipString(string code, int i)
    {
        var n = code.Length;
        var verbatim = false;
        while (i < n && (code[i] == '@' || code[i] == '$'))
        {
            if (code[i] == '@') verbatim = true;
            i++;
        }
        if (i >= n || code[i] != '"') return i + 1;
        i++;
        while (i < n)
        {
            if (verbatim)
            {
                if (code[i] == '"')
                {
                    if (i + 1 < n && code[i + 1] == '"') { i += 2; continue; }
                    return i + 1;
                }
                i++;
            }
            else
            {
                if (code[i] == '\\') { i += 2; continue; }
                if (code[i] == '"') return i + 1;
                i++;
            }
        }
        return i;
    }

    /// <summary>Index of the delimiter matching the one at <paramref name="openIdx"/> (string aware), or -1.</summary>
    public static int FindMatching(string code, int openIdx)
    {
        var open = code[openIdx];
        var close = open switch { '{' => '}', '(' => ')', '[' => ']', _ => '\0' };
        if (close == '\0') return -1;
        var depth = 0;
        var i = openIdx;
        var n = code.Length;
        while (i < n)
        {
            var c = code[i];
            if (c == '"' || ((c == '@' || c == '$') && i + 1 < n && code[i + 1] == '"'))
            {
                i = SkipString(code, i);
                continue;
            }
            if (c == '\'')
            {
                i++;
                while (i < n && code[i] != '\'')
                {
                    if (code[i] == '\\') i++;
                    i++;
                }
                i++;
                continue;
            }
            if (c == open) depth++;
            else if (c == close)
            {
                depth--;
                if (depth == 0) return i;
            }
            i++;
        }
        return -1;
    }

    /// <summary>Split on a separator occurring at delimiter-depth 0 (string aware).</summary>
    public static List<string> SplitTopLevel(string code, char sep)
    {
        var parts = new List<string>();
        var depth = 0;
        var start = 0;
        var i = 0;
        var n = code.Length;
        while (i < n)
        {
            var c = code[i];
            if (c == '"' || ((c == '@' || c == '$') && i + 1 < n && code[i + 1] == '"'))
            {
                i = SkipString(code, i);
                continue;
            }
            if (c == '\'')
            {
                i++;
                while (i < n && code[i] != '\'')
                {
                    if (code[i] == '\\') i++;
                    i++;
                }
                i++;
                continue;
            }
            if (c is '(' or '{' or '[') depth++;
            else if (c is ')' or '}' or ']') depth--;
            else if (depth == 0 && c == sep)
            {
                parts.Add(code[start..i]);
                start = i + 1;
                i++;
                continue;
            }
            i++;
        }
        var last = code[start..];
        if (last.Trim().Length > 0) parts.Add(last);
        return parts;
    }

    /// <summary>Parse a C# string literal to its value; returns the trimmed input if not a string literal.</summary>
    public static string Unquote(string raw)
    {
        var s = raw.Trim();
        if (s.StartsWith("@\"") && s.EndsWith('"'))
            return s[2..^1].Replace("\"\"", "\"");
        if (s.StartsWith('"') && s.EndsWith('"') && s.Length >= 2)
        {
            var body = s[1..^1];
            body = Regex.Replace(body, @"\\u([0-9a-fA-F]{4})",
                m => ((char)Convert.ToInt32(m.Groups[1].Value, 16)).ToString());
            body = Regex.Replace(body, @"\\(.)", m => m.Groups[1].Value switch
            {
                "n" => "\n", "r" => "\r", "t" => "\t", "0" => "\0",
                var other => other,
            });
            return body;
        }
        return s;
    }

    /// <summary>Best-effort conversion of a C# literal argument to a value (bool/number/string/null).</summary>
    public static object? LiteralValue(string raw)
    {
        var s = raw.Trim();
        if (s == "true") return true;
        if (s == "false") return false;
        if (s is "null" or "(string)null") return null;
        if (Regex.IsMatch(s, @"^-?\d+(\.\d+)?[mMfFdDlL]?$"))
            return double.Parse(Regex.Replace(s, "[mMfFdDlL]$", ""), System.Globalization.CultureInfo.InvariantCulture);
        if (s.StartsWith('"') || s.StartsWith("@\"")) return Unquote(s);
        return s;
    }

    public sealed record Call(string Name, string? Generic, List<string> Args);

    public sealed record Chain(string Root, List<Call> Calls);

    /// <summary>
    /// Parse a fluent chain like <c>b.Property&lt;int&gt;("Id").HasColumnType("int")</c>.
    /// Arguments are kept raw (strings, lambdas, enum members) for the caller to interpret.
    /// Returns null when the statement is not a simple chain.
    /// </summary>
    public static Chain? ParseChain(string stmt)
    {
        var s = stmt.Trim();
        var rootMatch = Regex.Match(s, @"^([A-Za-z_][\w.]*)\s*(?=[.(<])");
        if (!rootMatch.Success) return null;

        var calls = new List<Call>();
        var root = rootMatch.Groups[1].Value;
        int i;
        var lastDot = root.LastIndexOf('.');
        if (lastDot != -1)
        {
            var after = s[rootMatch.Value.Length..].TrimStart();
            if (after.StartsWith('(') || after.StartsWith('<'))
            {
                var firstCall = root[(lastDot + 1)..];
                root = root[..lastDot];
                i = s.IndexOf(firstCall, root.Length, StringComparison.Ordinal);
                i = ParseCallAt(s, i, firstCall, calls);
                if (i == -1) return null;
            }
            else
            {
                return null;
            }
        }
        else
        {
            i = rootMatch.Value.Length;
        }

        while (i < s.Length)
        {
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
            if (i >= s.Length) break;
            if (s[i] != '.') return calls.Count > 0 ? new Chain(root, calls) : null;
            i++;
            var nameMatch = Regex.Match(s[i..], @"^[A-Za-z_]\w*");
            if (!nameMatch.Success) return null;
            i = ParseCallAt(s, i, nameMatch.Value, calls);
            if (i == -1) return null;
        }
        return new Chain(root, calls);
    }

    private static int ParseCallAt(string s, int i, string name, List<Call> calls)
    {
        i += name.Length;
        string? generic = null;
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        if (i < s.Length && s[i] == '<')
        {
            var end = FindGenericEnd(s, i);
            if (end == -1) return -1;
            generic = s[(i + 1)..end].Trim();
            i = end + 1;
            while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
        }
        if (i >= s.Length || s[i] != '(')
        {
            calls.Add(new Call(name, generic, new List<string>()));
            return i;
        }
        var close = FindMatching(s, i);
        if (close == -1) return -1;
        var inner = s[(i + 1)..close];
        var args = inner.Trim().Length == 0
            ? new List<string>()
            : SplitTopLevel(inner, ',').Select(a => a.Trim()).ToList();
        calls.Add(new Call(name, generic, args));
        return close + 1;
    }

    private static int FindGenericEnd(string s, int i)
    {
        var depth = 0;
        for (; i < s.Length; i++)
        {
            if (s[i] == '<') depth++;
            else if (s[i] == '>')
            {
                depth--;
                if (depth == 0) return i;
            }
            else if (s[i] is '(' or ';') return -1;
        }
        return -1;
    }

    /// <summary>Extract the body of a block lambda argument like <c>b => { ... }</c>.</summary>
    public static string? LambdaBody(string raw)
    {
        var m = Regex.Match(raw, @"^\s*[A-Za-z_]\w*\s*=>\s*");
        if (!m.Success) return null;
        var rest = raw[m.Value.Length..].Trim();
        if (rest.StartsWith('{'))
        {
            var close = FindMatching(rest, 0);
            return close == -1 ? null : rest[1..close];
        }
        return rest;
    }

    /// <summary>Shorten a fully-qualified type name to its simple name.</summary>
    public static string SimpleName(string fqn)
    {
        var noGenerics = fqn.Split('<')[0];
        var parts = noGenerics.Split('.');
        var name = parts[^1];
        if (name.Contains('+')) name = name.Split('+')[^1];
        return name;
    }
}
