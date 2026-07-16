using System;
using System.Collections.Generic;
using System.Drawing;
using System.Reflection;
using System.Threading;
using System.Windows.Forms;
using ClaudeOpenLauncher;

// Focused launcher smoke test. It does not launch the adapter/client or contact
// a gateway; it verifies that the dashboard can be constructed and can parse
// dynamic model metadata without relying on compiled model names.
internal static class LauncherSmokeTest
{
    [STAThread]
    private static int Main()
    {
        Application.EnableVisualStyles();
        using (ClaudeOpenForm form = new ClaudeOpenForm())
        {
            Assert(form.MinimumSize.Width >= 1000, "dashboard minimum width");
            // Phase 7: one coherent Claude-dark theme, dark on first paint (no cream flash).
            Assert(form.BackColor == Color.FromArgb(38, 38, 36), "Claude-dark main background #262624");

            Type type = typeof(ClaudeOpenForm);
            Assert(Field<Panel>(type, form, "modelPanel") != null, "live model panel");
            Assert(Field<ComboBox>(type, form, "modelComboBox") != null, "model selector");
            Assert(Field<ComboBox>(type, form, "effortComboBox") != null, "effort selector");
            Assert(Field<Button>(type, form, "applyEffortButton") != null, "verified effort apply button");
            Assert(Field<ProgressBar>(type, form, "contextProgressBar") != null, "context meter");

            Dictionary<string, object> reasoning = new Dictionary<string, object>();
            reasoning["controlType"] = "categorical";
            reasoning["field"] = "reasoning.effort";
            reasoning["values"] = new object[] { "low", "high" };
            reasoning["default"] = "high";
            reasoning["source"] = "probe";
            reasoning["selected"] = "high";
            // Only behavior-observed accompanies an enabled/selected value now
            // (Phase 6: schema-accepted never flips a selector to verified).
            reasoning["verification"] = "behavior-observed";
            Dictionary<string, object> meta = new Dictionary<string, object>();
            meta["realId"] = "gateway-owned-model-id";
            meta["provider"] = "Gateway provider";
            meta["modelType"] = "reasoning-text";
            meta["contextWindow"] = 123456;
            meta["contextSource"] = "gateway";
            meta["reasoning"] = reasoning;
            Dictionary<string, object> row = new Dictionary<string, object>();
            row["id"] = "stable-alias";
            row["display_name"] = "Gateway Model";
            row["claude_open"] = meta;
            Dictionary<string, object> payload = new Dictionary<string, object>();
            payload["data"] = new object[] { row };

            MethodInfo parse = type.GetMethod("ParseModels", BindingFlags.Instance | BindingFlags.NonPublic);
            object parsed = parse.Invoke(form, new object[] { payload });
            int count = Convert.ToInt32(parsed.GetType().GetProperty("Count").GetValue(parsed, null));
            Assert(count == 1, "dynamic model parser");
            type.GetField("controlToken", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, "test-local-control-token");
            type.GetMethod("ApplyModels", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { parsed });
            Assert(Field<ComboBox>(type, form, "effortComboBox").Items.Count == 2, "dynamic effort values");
            Assert(Field<ComboBox>(type, form, "effortComboBox").SelectedItem.ToString() == "high", "persisted effort selection");
            Assert(Field<Button>(type, form, "applyEffortButton").Enabled, "apply enabled for verified values");
            Assert(Field<Label>(type, form, "effortTruthLabel").Text.Contains("Applied to future requests"), "applied truth label comes from adapter selection");

            Dictionary<string, object> totals = new Dictionary<string, object>();
            totals["inputTokens"] = 80;
            totals["outputTokens"] = 40;
            totals["totalTokens"] = 120;
            Dictionary<string, object> context = new Dictionary<string, object>();
            context["window"] = 123456;
            context["usedTokens"] = 120;
            context["utilizationPercent"] = 0.1;
            Dictionary<string, object> telemetryModel = new Dictionary<string, object>();
            telemetryModel["model"] = "gateway-owned-model-id";
            telemetryModel["requests"] = 1;
            telemetryModel["totals"] = totals;
            telemetryModel["context"] = context;
            Dictionary<string, object> usage = new Dictionary<string, object>();
            usage["scope"] = "adapter-process-session";
            usage["models"] = new object[] { telemetryModel };
            type.GetMethod("ApplyUsage", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(form, new object[] { usage });
            Assert(Field<Label>(type, form, "usageValueLabel").Text.Contains("120"), "exact usage array schema");
            Assert(Field<Label>(type, form, "contextValueLabel").Text.Contains("0.1%"), "context utilization provenance");

            AssertWrite3pArgs(type);
        }
        Console.WriteLine("Launcher smoke test: PASS");
        return 0;
    }

    // FIX 1(a) + FIX 3(a): the launcher must build the write-3p-config argv with
    // the LIVE bound adapter port (activePort, never the retired 8788) AND the
    // family-tier flags (--assign-family-tiers, --unhealthy <csv of overloaded>)
    // plus the healthy opus --default, so the client picker shows all models and
    // its per-tier probes resolve to a healthy model.
    private static void AssertWrite3pArgs(Type type)
    {
        MethodInfo build = type.GetMethod("BuildWrite3pArgs", BindingFlags.Static | BindingFlags.NonPublic);
        Assert(build != null, "BuildWrite3pArgs exists");

        int activePort = 51843; // simulated LIVE ephemeral port (not 8788)
        string[] overloaded = new string[] { "claude-haiku-4-5", "claude-sonnet-4-6", "gpt-5.4" };
        object argsObj = build.Invoke(null, new object[] {
            @"C:\install\scripts\write-3p-config.mjs", // shim
            @"C:\harness",                              // harnessRoot
            @"C:\profile",                              // profilePath
            activePort,                                  // activePort
            "client-token-abc",                         // clientToken
            @"C:\runtime\models.json",                  // modelsFile
            "claude-opus-4-8",                          // defaultAlias
            overloaded                                    // unhealthy list
        });
        List<string> args = argsObj as List<string>;
        Assert(args != null, "BuildWrite3pArgs returns List<string>");

        Assert(Contains(args, "--production"), "argv has --production");
        Assert(Contains(args, "--assign-family-tiers"), "argv has --assign-family-tiers");
        int baseIdx = IndexOf(args, "--base-url");
        Assert(baseIdx >= 0 && args[baseIdx + 1] == "http://127.0.0.1:51843", "argv --base-url uses live activePort");
        Assert(!ArgsContainSubstring(args, "8788"), "argv never contains the retired 8788 port");
        int defIdx = IndexOf(args, "--default");
        Assert(defIdx >= 0 && args[defIdx + 1] == "claude-opus-4-8", "argv --default is the healthy opus");
        int unhealthyIdx = IndexOf(args, "--unhealthy");
        Assert(unhealthyIdx >= 0, "argv has --unhealthy");
        Assert(args[unhealthyIdx + 1] == "claude-haiku-4-5,claude-sonnet-4-6,gpt-5.4", "argv --unhealthy is comma-joined overloaded models");
    }

    private static bool Contains(List<string> args, string value)
    {
        return args.IndexOf(value) >= 0;
    }

    private static int IndexOf(List<string> args, string value)
    {
        return args.IndexOf(value);
    }

    private static bool ArgsContainSubstring(List<string> args, string needle)
    {
        foreach (string a in args) if (a != null && a.IndexOf(needle, StringComparison.Ordinal) >= 0) return true;
        return false;
    }

    private static T Field<T>(Type type, object instance, string name) where T : class
    {
        return type.GetField(name, BindingFlags.Instance | BindingFlags.NonPublic).GetValue(instance) as T;
    }

    private static void Assert(bool condition, string name)
    {
        if (!condition) throw new Exception("FAILED: " + name);
    }
}
