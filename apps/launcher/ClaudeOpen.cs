using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Diagnostics;
using System.Drawing;
using System.Windows.Forms;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Web.Script.Serialization;
using System.Threading;
using System.Security.Cryptography;
using System.Reflection;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.RegularExpressions;

[assembly: AssemblyTitle("Claude Open")]
[assembly: AssemblyDescription("Claude Open launcher and gateway control center")]
[assembly: AssemblyCompany("Claude Open Contributors")]
[assembly: AssemblyProduct("Claude Open")]
[assembly: AssemblyVersion("0.2.0.0")]
[assembly: AssemblyFileVersion("0.2.0.0")]

namespace ClaudeOpenLauncher
{
    public class ClaudeOpenForm : Form
    {
        [DllImport("shell32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern int SetCurrentProcessExplicitAppUserModelID(string appID);
        // P/Invoke for Credential Manager
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        internal struct CREDENTIAL
        {
            public int Flags;
            public int Type;
            public string TargetName;
            public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public int CredentialBlobSize;
            public IntPtr CredentialBlob;
            public int Persist;
            public int AttributeCount;
            public IntPtr Attributes;
            public string TargetAlias;
            public string UserName;
        }

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CredWrite(ref CREDENTIAL userCredential, int flags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CredDelete(string target, int type, int flags);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        internal static extern bool CredRead(string target, int type, int flags, out IntPtr credentialPtr);

        [DllImport("advapi32.dll", SetLastError = false)]
        internal static extern void CredFree(IntPtr credentialPtr);

        // GUI controls
        private Label titleLabel;
        private Panel setupPanel;
        private Label urlLabel;
        private TextBox urlTextBox;
        private Label authLabel;
        private ComboBox authComboBox;
        private Label headerLabel;
        private TextBox headerTextBox;
        private Label keyLabel;
        private TextBox keyTextBox;
        private Button saveButton;
        private Button removeSecretButton;

        private Panel statusPanel;
        private Label statusTitleLabel;
        private Label configStatusLabel;
        private Label secretStatusLabel;
        private Label adapterStatusLabel;
        private Label healthStatusLabel;
        private Button testConnectionButton;

        private Button launchButton;
        private RichTextBox logBox;

        // Live model / context / usage controls. Every value shown here is
        // fetched from the authenticated loopback adapter; none is compiled
        // into the launcher.
        private Panel modelPanel;
        private ComboBox modelComboBox;
        private ComboBox effortComboBox;
        private Button refreshModelsButton;
        private Button probeEffortButton;
        private Button applyEffortButton;
        private CheckBox companionCheckBox;
        private Button companionSetupButton;
        private Label modelCountLabel;
        private Label contextValueLabel;
        private Label usageValueLabel;
        private Label effortTruthLabel;
        private Label modelMetaLabel;
        private ProgressBar contextProgressBar;
        private readonly List<ModelView> liveModels = new List<ModelView>();
        private DateTime lastDashboardRefresh = DateTime.MinValue;
        private bool dashboardBusy = false;

        // Claude-dark palette (Phase 7 tokens from CORRECTIVE-IMPLEMENTATION-PLAN.md,
        // matching installed Claude 1.20186.1). One coherent dark theme, applied
        // directly at control construction so the UI is dark on first paint with no
        // cream flash. Names are kept semantic: *Cream = main bg, *Paper = card
        // surface, *Ink = primary text, *Muted = muted text, *Terracotta = clay accent.
        private static readonly Color ClaudeCream = Color.FromArgb(38, 38, 36);     // main bg #262624
        private static readonly Color ClaudePaper = Color.FromArgb(31, 30, 29);     // deeper surface hsl(30 3.3% 11.8%)
        private static readonly Color ClaudeSurfaceDeep = Color.FromArgb(20, 20, 19); // deepest surface hsl(60 2.6% 7.6%)
        private static readonly Color ClaudeInk = Color.FromArgb(245, 244, 239);    // primary text #f5f4ef
        private static readonly Color ClaudeSecondary = Color.FromArgb(229, 229, 226); // secondary text #e5e5e2
        private static readonly Color ClaudeMuted = Color.FromArgb(184, 181, 169);  // muted text #b8b5a9
        private static readonly Color ClaudeTerracotta = Color.FromArgb(217, 119, 87); // clay accent #d97757
        private static readonly Color ClaudeBorder = Color.FromArgb(74, 73, 70);    // subtle border (opaque render of #eaddd81a on #262624)
        private static readonly Color ClaudeSuccess = Color.FromArgb(122, 197, 155); // readable green on dark
        private static readonly Color ClaudeDanger = Color.FromArgb(224, 122, 116);  // readable red on dark
        private static readonly Color ClaudeWarning = Color.FromArgb(226, 183, 108); // readable amber/pending on dark

        // State
        private string configPath;
        private string appDataDir;
        private string localDataDir;
        private string runtimeDir;
        private Dictionary<string, object> currentConfig;
        
        private Process adapterProcess;
        private Process clientProcess;
        private int activePort = 0;
        private System.Windows.Forms.Timer processMonitorTimer;
        private string targetCredentialName = "";
        private string clientToken = "";
        private string controlToken = "";
        private string profilePath;
        private int restartAttempts = 0;
        private DateTime lastAdapterStart = DateTime.MinValue;
        private bool stopping = false;
        private int companionPort = 0;
        private string companionPairingCode = "";
        private string companionPairingExpiresAt = "";

        private sealed class ModelView
        {
            public string Alias;
            public string RealId;
            public string DisplayName;
            public string Provider;
            public string ModelType;
            public long? ContextWindow;
            public string ContextSource;
            public string ControlType;
            public string EffortField;
            public string EffortSource;
            public string EffortReason;
            public readonly List<string> EffortValues = new List<string>();
            public string EffortDefault;
            public string EffortSelected;
            public string EffortVerification;
            public long? EffortMin;
            public long? EffortMax;

            public override string ToString()
            {
                return string.IsNullOrEmpty(DisplayName) ? RealId : DisplayName;
            }
        }

        public ClaudeOpenForm()
        {
            // Explicit AUMID for the LAUNCHER, outside Anthropic's `com.anthropic.*`
            // namespace so Windows's taskbar/pin grouping keeps this fork visually
            // separate from normal Claude. Matches the .lnk's System.AppUserModel.ID
            // set by installer/Install-ClaudeOpen.ps1 and the MSIX-registered
            // family form (ClaudeOpen_<publisherHash>!ClaudeOpen) when the sparse
            // identity package is registered per-user.
            SetCurrentProcessExplicitAppUserModelID("ClaudeOpen.Launcher");
            InitializePaths();
            InitializeComponent();
            LoadConfig();
            UpdateStatusDisplay();

            // Set up timer for monitoring processes
            processMonitorTimer = new System.Windows.Forms.Timer();
            processMonitorTimer.Interval = 2000; // Check every 2 seconds
            processMonitorTimer.Tick += ProcessMonitorTimer_Tick;
            processMonitorTimer.Start();
        }

        private void InitializePaths()
        {
            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            
            appDataDir = Path.Combine(appData, "ClaudeOpen");
            // Keep every Claude Open-owned artifact under one deterministic
            // per-user root. This also avoids Windows packaged-app redirection
            // differences observed when a copied signed client is launched.
            localDataDir = Path.Combine(appDataDir, "User Data");
            runtimeDir = Path.Combine(localDataDir, "runtime");
            profilePath = Path.Combine(localDataDir, "profile");

            if (!Directory.Exists(appDataDir)) Directory.CreateDirectory(appDataDir);
            if (!Directory.Exists(localDataDir)) Directory.CreateDirectory(localDataDir);
            if (!Directory.Exists(runtimeDir)) Directory.CreateDirectory(runtimeDir);
            if (!Directory.Exists(profilePath)) Directory.CreateDirectory(profilePath);

            ProtectDirectory(appDataDir);
            ProtectDirectory(localDataDir);
            ProtectDirectory(runtimeDir);
            ProtectDirectory(profilePath);

            configPath = Path.Combine(appDataDir, "config.json");
        }

        private void InitializeComponent()
        {
            this.Text = "Claude Open - Control Center";
            this.Size = new Size(1040, 790);
            this.MinimumSize = new Size(1040, 790);
            this.BackColor = ClaudeCream;
            this.ForeColor = ClaudeInk;
            this.Font = new Font("Segoe UI", 9.5F, FontStyle.Regular);
            this.StartPosition = FormStartPosition.CenterScreen;
            try { this.Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }

            // Title
            titleLabel = new Label();
            titleLabel.Text = "Claude Open Control Center";
            titleLabel.Font = new Font("Segoe UI", 16F, FontStyle.Bold);
            titleLabel.ForeColor = ClaudeInk;
            titleLabel.Location = new Point(20, 15);
            titleLabel.Size = new Size(400, 35);
            this.Controls.Add(titleLabel);

            // Launch Button (Big, Prominent)
            launchButton = new Button();
            launchButton.Text = "Launch Claude Open";
            launchButton.Font = new Font("Segoe UI", 12F, FontStyle.Bold);
            launchButton.BackColor = ClaudeTerracotta;
            launchButton.ForeColor = Color.White;
            launchButton.FlatStyle = FlatStyle.Flat;
            launchButton.FlatAppearance.BorderSize = 0;
            launchButton.Location = new Point(440, 15);
            launchButton.Size = new Size(210, 40);
            launchButton.Click += LaunchButton_Click;
            this.Controls.Add(launchButton);

            // Left Panel: Setup
            setupPanel = new Panel();
            setupPanel.Location = new Point(20, 70);
            setupPanel.Size = new Size(390, 280);
            setupPanel.BackColor = ClaudePaper;
            setupPanel.ForeColor = ClaudeInk;
            setupPanel.Padding = new Padding(15);
            this.Controls.Add(setupPanel);

            Label setupTitle = new Label();
            setupTitle.Text = "GATEWAY CONFIGURATION";
            setupTitle.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            setupTitle.ForeColor = ClaudeTerracotta;
            setupTitle.Location = new Point(15, 10);
            setupTitle.Size = new Size(250, 20);
            setupPanel.Controls.Add(setupTitle);

            urlLabel = new Label();
            urlLabel.Text = "Gateway Base URL:";
            urlLabel.Location = new Point(15, 35);
            urlLabel.Size = new Size(150, 20);
            setupPanel.Controls.Add(urlLabel);

            urlTextBox = new TextBox();
            urlTextBox.Location = new Point(15, 55);
            urlTextBox.Size = new Size(360, 25);
            urlTextBox.BackColor = ClaudeSurfaceDeep;
            urlTextBox.ForeColor = ClaudeInk;
            urlTextBox.BorderStyle = BorderStyle.FixedSingle;
            setupPanel.Controls.Add(urlTextBox);

            authLabel = new Label();
            authLabel.Text = "Auth Kind:";
            authLabel.Location = new Point(15, 85);
            authLabel.Size = new Size(100, 20);
            setupPanel.Controls.Add(authLabel);

            authComboBox = new ComboBox();
            authComboBox.Items.AddRange(new string[] { "bearer", "x-api-key", "custom-header", "none" });
            authComboBox.Location = new Point(15, 105);
            authComboBox.Size = new Size(170, 25);
            authComboBox.DropDownStyle = ComboBoxStyle.DropDownList;
            authComboBox.BackColor = ClaudeSurfaceDeep;
            authComboBox.ForeColor = ClaudeInk;
            authComboBox.FlatStyle = FlatStyle.Flat;
            authComboBox.SelectedIndexChanged += AuthComboBox_SelectedIndexChanged;
            setupPanel.Controls.Add(authComboBox);

            headerLabel = new Label();
            headerLabel.Text = "Header Name:";
            headerLabel.Location = new Point(205, 85);
            headerLabel.Size = new Size(150, 20);
            headerLabel.Visible = false;
            setupPanel.Controls.Add(headerLabel);

            headerTextBox = new TextBox();
            headerTextBox.Location = new Point(205, 105);
            headerTextBox.Size = new Size(170, 25);
            headerTextBox.BackColor = ClaudeSurfaceDeep;
            headerTextBox.ForeColor = ClaudeInk;
            headerTextBox.BorderStyle = BorderStyle.FixedSingle;
            headerTextBox.Visible = false;
            setupPanel.Controls.Add(headerTextBox);

            keyLabel = new Label();
            keyLabel.Text = "API Key / Secret:";
            keyLabel.Location = new Point(15, 135);
            keyLabel.Size = new Size(150, 20);
            setupPanel.Controls.Add(keyLabel);

            keyTextBox = new TextBox();
            keyTextBox.Location = new Point(15, 155);
            keyTextBox.Size = new Size(360, 25);
            keyTextBox.PasswordChar = '*';
            keyTextBox.BackColor = ClaudeSurfaceDeep;
            keyTextBox.ForeColor = ClaudeInk;
            keyTextBox.BorderStyle = BorderStyle.FixedSingle;
            setupPanel.Controls.Add(keyTextBox);

            saveButton = new Button();
            saveButton.Text = "Save Configuration";
            saveButton.BackColor = ClaudeTerracotta;
            saveButton.ForeColor = Color.White;
            saveButton.FlatStyle = FlatStyle.Flat;
            saveButton.FlatAppearance.BorderSize = 0;
            saveButton.Location = new Point(15, 200);
            saveButton.Size = new Size(170, 30);
            saveButton.Click += SaveButton_Click;
            setupPanel.Controls.Add(saveButton);

            removeSecretButton = new Button();
            removeSecretButton.Text = "Remove Secret";
            removeSecretButton.BackColor = ClaudePaper;
            removeSecretButton.ForeColor = ClaudeDanger;
            removeSecretButton.FlatStyle = FlatStyle.Flat;
            removeSecretButton.FlatAppearance.BorderSize = 1;
            removeSecretButton.FlatAppearance.BorderColor = ClaudeBorder;
            removeSecretButton.Location = new Point(205, 200);
            removeSecretButton.Size = new Size(170, 30);
            removeSecretButton.Click += RemoveSecretButton_Click;
            setupPanel.Controls.Add(removeSecretButton);

            // Right Panel: Status
            statusPanel = new Panel();
            statusPanel.Location = new Point(420, 70);
            statusPanel.Size = new Size(230, 280);
            statusPanel.BackColor = ClaudePaper;
            statusPanel.ForeColor = ClaudeInk;
            statusPanel.Padding = new Padding(15);
            this.Controls.Add(statusPanel);

            statusTitleLabel = new Label();
            statusTitleLabel.Text = "SYSTEM STATUS";
            statusTitleLabel.Font = new Font("Segoe UI", 10F, FontStyle.Bold);
            statusTitleLabel.ForeColor = ClaudeTerracotta;
            statusTitleLabel.Location = new Point(15, 10);
            statusTitleLabel.Size = new Size(150, 20);
            statusPanel.Controls.Add(statusTitleLabel);

            configStatusLabel = new Label();
            configStatusLabel.Text = "Config: Checking...";
            configStatusLabel.Location = new Point(15, 40);
            configStatusLabel.Size = new Size(200, 20);
            statusPanel.Controls.Add(configStatusLabel);

            secretStatusLabel = new Label();
            secretStatusLabel.Text = "Secret: Checking...";
            secretStatusLabel.Location = new Point(15, 70);
            secretStatusLabel.Size = new Size(200, 20);
            statusPanel.Controls.Add(secretStatusLabel);

            adapterStatusLabel = new Label();
            adapterStatusLabel.Text = "Adapter: Checking...";
            adapterStatusLabel.Location = new Point(15, 100);
            adapterStatusLabel.Size = new Size(200, 35); // multi line potential
            statusPanel.Controls.Add(adapterStatusLabel);

            healthStatusLabel = new Label();
            healthStatusLabel.Text = "Deep Health: Checked";
            healthStatusLabel.Location = new Point(15, 140);
            healthStatusLabel.Size = new Size(200, 35);
            statusPanel.Controls.Add(healthStatusLabel);

            testConnectionButton = new Button();
            testConnectionButton.Text = "Verify Gateway";
            testConnectionButton.BackColor = ClaudePaper;
            testConnectionButton.ForeColor = ClaudeInk;
            testConnectionButton.FlatStyle = FlatStyle.Flat;
            testConnectionButton.FlatAppearance.BorderSize = 1;
            testConnectionButton.FlatAppearance.BorderColor = ClaudeBorder;
            testConnectionButton.Location = new Point(15, 200);
            testConnectionButton.Size = new Size(200, 30);
            testConnectionButton.Click += TestConnectionButton_Click;
            statusPanel.Controls.Add(testConnectionButton);

            // Log Console (Bottom)
            logBox = new RichTextBox();
            logBox.Location = new Point(20, 365);
            logBox.Size = new Size(630, 140);
            logBox.ReadOnly = true;
            logBox.BackColor = ClaudeSurfaceDeep;
            logBox.ForeColor = ClaudeSecondary;
            logBox.BorderStyle = BorderStyle.None;
            logBox.Font = new Font("Consolas", 9.0F);
            this.Controls.Add(logBox);

            BuildLiveModelPanel();

            AppendLog("Claude Open Control Center initialized.");
            AppendLog("User data: " + localDataDir);
        }

        private void BuildLiveModelPanel()
        {
            // Reflow the original configuration/status areas into two balanced cards.
            titleLabel.Text = "Claude Open";
            titleLabel.Location = new Point(24, 18);
            titleLabel.Size = new Size(480, 38);
            launchButton.Location = new Point(790, 16);
            launchButton.Size = new Size(220, 42);

            setupPanel.Location = new Point(24, 76);
            setupPanel.Size = new Size(482, 272);
            statusPanel.Location = new Point(522, 76);
            statusPanel.Size = new Size(488, 272);
            urlTextBox.Size = new Size(450, 25);
            keyTextBox.Size = new Size(450, 25);
            authComboBox.Size = new Size(210, 25);
            headerLabel.Location = new Point(250, 85);
            headerTextBox.Location = new Point(250, 105);
            headerTextBox.Size = new Size(215, 25);
            saveButton.Size = new Size(210, 32);
            removeSecretButton.Location = new Point(250, 200);
            removeSecretButton.Size = new Size(215, 32);

            companionCheckBox = new CheckBox();
            companionCheckBox.Text = "Enable mobile companion (opt-in)";
            companionCheckBox.Location = new Point(15, 239);
            companionCheckBox.Size = new Size(280, 24);
            companionCheckBox.ForeColor = ClaudeMuted;
            companionCheckBox.BackColor = ClaudePaper;
            setupPanel.Controls.Add(companionCheckBox);

            configStatusLabel.Size = new Size(440, 20);
            secretStatusLabel.Size = new Size(440, 20);
            adapterStatusLabel.Size = new Size(440, 35);
            healthStatusLabel.Size = new Size(440, 35);
            testConnectionButton.Size = new Size(210, 32);

            companionSetupButton = NewButton("Mobile setup", 250, 200, 215, 32, false);
            companionSetupButton.Click += CompanionSetupButton_Click;
            statusPanel.Controls.Add(companionSetupButton);

            modelPanel = new Panel();
            modelPanel.Location = new Point(24, 364);
            modelPanel.Size = new Size(986, 276);
            modelPanel.Padding = new Padding(16);
            modelPanel.BackColor = ClaudePaper;
            modelPanel.ForeColor = ClaudeInk;
            this.Controls.Add(modelPanel);

            Label heading = NewLabel("MODELS, CONTEXT & USAGE", 16, 12, 330, 22, true);
            modelPanel.Controls.Add(heading);
            modelCountLabel = NewLabel("Launch to discover models", 704, 13, 248, 20, false);
            modelCountLabel.TextAlign = ContentAlignment.MiddleRight;
            modelPanel.Controls.Add(modelCountLabel);

            Label modelLabel = NewLabel("Model from your gateway", 16, 48, 250, 20, false);
            modelPanel.Controls.Add(modelLabel);
            modelComboBox = new ComboBox();
            modelComboBox.Location = new Point(16, 70);
            modelComboBox.Size = new Size(420, 28);
            modelComboBox.DropDownStyle = ComboBoxStyle.DropDownList;
            modelComboBox.FlatStyle = FlatStyle.Flat;
            modelComboBox.BackColor = ClaudeSurfaceDeep;
            modelComboBox.ForeColor = ClaudeInk;
            modelComboBox.SelectedIndexChanged += ModelComboBox_SelectedIndexChanged;
            modelPanel.Controls.Add(modelComboBox);

            refreshModelsButton = NewButton("Refresh", 448, 69, 104, 30, false);
            refreshModelsButton.Click += RefreshModelsButton_Click;
            modelPanel.Controls.Add(refreshModelsButton);

            modelMetaLabel = NewLabel("Model metadata will appear after launch.", 16, 105, 536, 42, false);
            modelMetaLabel.ForeColor = ClaudeMuted;
            modelPanel.Controls.Add(modelMetaLabel);

            Label contextHeading = NewLabel("Context window", 576, 48, 180, 20, false);
            modelPanel.Controls.Add(contextHeading);
            contextValueLabel = NewLabel("Not reported", 576, 70, 376, 28, true);
            contextValueLabel.Font = new Font("Segoe UI", 13F, FontStyle.Bold);
            modelPanel.Controls.Add(contextValueLabel);
            contextProgressBar = new ProgressBar();
            contextProgressBar.Location = new Point(576, 105);
            contextProgressBar.Size = new Size(376, 10);
            contextProgressBar.Style = ProgressBarStyle.Continuous;
            modelPanel.Controls.Add(contextProgressBar);
            usageValueLabel = NewLabel("Session usage: waiting for local telemetry", 576, 122, 376, 42, false);
            usageValueLabel.ForeColor = ClaudeMuted;
            modelPanel.Controls.Add(usageValueLabel);

            Label effortHeading = NewLabel("Reasoning effort", 16, 166, 180, 20, false);
            modelPanel.Controls.Add(effortHeading);
            effortComboBox = new ComboBox();
            effortComboBox.Location = new Point(16, 189);
            effortComboBox.Size = new Size(230, 28);
            effortComboBox.DropDownStyle = ComboBoxStyle.DropDownList;
            effortComboBox.FlatStyle = FlatStyle.Flat;
            effortComboBox.BackColor = ClaudeSurfaceDeep;
            effortComboBox.ForeColor = ClaudeInk;
            effortComboBox.Enabled = false;
            modelPanel.Controls.Add(effortComboBox);

            probeEffortButton = NewButton("Verify & apply", 258, 188, 145, 31, true);
            probeEffortButton.Click += ProbeEffortButton_Click;
            probeEffortButton.Enabled = false;
            modelPanel.Controls.Add(probeEffortButton);

            applyEffortButton = NewButton("Apply verified", 414, 188, 130, 31, false);
            applyEffortButton.Click += ApplyEffortButton_Click;
            applyEffortButton.Enabled = false;
            modelPanel.Controls.Add(applyEffortButton);

            effortTruthLabel = NewLabel("No model selected. Effort is never guessed.", 558, 177, 394, 66, false);
            effortTruthLabel.ForeColor = ClaudeMuted;
            modelPanel.Controls.Add(effortTruthLabel);

            logBox.Location = new Point(24, 654);
            logBox.Size = new Size(986, 78);
        }

        private Label NewLabel(string text, int x, int y, int width, int height, bool strong)
        {
            Label label = new Label();
            label.Text = text;
            label.Location = new Point(x, y);
            label.Size = new Size(width, height);
            label.Font = new Font("Segoe UI", 9.5F, strong ? FontStyle.Bold : FontStyle.Regular);
            label.ForeColor = ClaudeInk;
            return label;
        }

        private Button NewButton(string text, int x, int y, int width, int height, bool accent)
        {
            Button button = new Button();
            button.Text = text;
            button.Location = new Point(x, y);
            button.Size = new Size(width, height);
            button.FlatStyle = FlatStyle.Flat;
            button.FlatAppearance.BorderSize = 1;
            button.FlatAppearance.BorderColor = accent ? ClaudeTerracotta : ClaudeBorder;
            button.BackColor = accent ? ClaudeTerracotta : ClaudePaper;
            button.ForeColor = accent ? Color.White : ClaudeInk;
            return button;
        }

        private void AppendLog(string message)
        {
            if (logBox.InvokeRequired)
            {
                logBox.Invoke(new Action<string>(AppendLog), message);
                return;
            }
            logBox.AppendText("[" + DateTime.Now.ToString("HH:mm:ss") + "] " + message + "\r\n");
            logBox.SelectionStart = logBox.Text.Length;
            logBox.ScrollToCaret();
        }

        private void RefreshModelsButton_Click(object sender, EventArgs e)
        {
            RefreshLiveDashboard(true);
        }

        private void RefreshLiveDashboard(bool announceErrors)
        {
            if (dashboardBusy || activePort <= 0 || string.IsNullOrEmpty(clientToken))
            {
                if (announceErrors) MessageBox.Show("Launch Claude Open first so the local adapter can discover your gateway.", "Adapter Not Running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            dashboardBusy = true;
            refreshModelsButton.Enabled = false;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> payload = GetLocalJson("/v1/models", false);
                    List<ModelView> parsed = ParseModels(payload);
                    Dictionary<string, object> usage = null;
                    try { usage = GetLocalJson("/usage", false); } catch { }
                    this.BeginInvoke(new Action(delegate
                    {
                        ApplyModels(parsed);
                        ApplyUsage(usage);
                        lastDashboardRefresh = DateTime.UtcNow;
                    }));
                }
                catch (Exception ex)
                {
                    if (announceErrors) this.BeginInvoke(new Action(delegate { MessageBox.Show("Could not refresh gateway models: " + ex.Message, "Refresh Failed", MessageBoxButtons.OK, MessageBoxIcon.Warning); }));
                }
                finally
                {
                    this.BeginInvoke(new Action(delegate { dashboardBusy = false; refreshModelsButton.Enabled = true; }));
                }
            });
        }

        private Dictionary<string, object> GetLocalJson(string path, bool controlAuth)
        {
            ReadRuntimeState();
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + activePort + path);
            request.Method = "GET";
            request.Timeout = 10000;
            if (controlAuth)
                request.Headers["x-claude-open-diag"] = controlToken;
            else
                request.Headers[HttpRequestHeader.Authorization] = "Bearer " + clientToken;
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }

        private Dictionary<string, object> PostControlJson(string path, Dictionary<string, object> body)
        {
            ReadRuntimeState();
            byte[] bytes = Encoding.UTF8.GetBytes(new JavaScriptSerializer().Serialize(body));
            HttpWebRequest request = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + activePort + path);
            request.Method = "POST";
            request.Timeout = 120000;
            request.ContentType = "application/json";
            request.ContentLength = bytes.Length;
            request.Headers["x-claude-open-diag"] = controlToken;
            using (Stream stream = request.GetRequestStream()) stream.Write(bytes, 0, bytes.Length);
            using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
            using (StreamReader reader = new StreamReader(response.GetResponseStream()))
                return new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
        }

        private List<ModelView> ParseModels(Dictionary<string, object> payload)
        {
            List<ModelView> result = new List<ModelView>();
            object rawData;
            if (payload == null || !payload.TryGetValue("data", out rawData)) return result;
            object[] rows = rawData as object[];
            if (rows == null) return result;
            foreach (object raw in rows)
            {
                Dictionary<string, object> row = raw as Dictionary<string, object>;
                if (row == null) continue;
                ModelView view = new ModelView();
                view.Alias = StringValue(row, "id");
                view.DisplayName = StringValue(row, "display_name");
                Dictionary<string, object> meta = DictionaryValue(row, "claude_open");
                view.RealId = StringValue(meta, "realId");
                view.Provider = StringValue(meta, "provider");
                view.ModelType = StringValue(meta, "modelType");
                view.ContextSource = StringValue(meta, "contextSource");
                object context;
                if (meta != null && meta.TryGetValue("contextWindow", out context) && context != null)
                {
                    try { view.ContextWindow = Convert.ToInt64(context); } catch { }
                }
                Dictionary<string, object> reasoning = DictionaryValue(meta, "reasoning");
                view.ControlType = StringValue(reasoning, "controlType");
                view.EffortField = StringValue(reasoning, "field");
                view.EffortSource = StringValue(reasoning, "source");
                view.EffortReason = StringValue(reasoning, "reason");
                view.EffortDefault = StringValue(reasoning, "default");
                view.EffortSelected = StringValue(reasoning, "selected");
                view.EffortVerification = StringValue(reasoning, "verification");
                object bound;
                if (reasoning != null && reasoning.TryGetValue("min", out bound) && bound != null) try { view.EffortMin = Convert.ToInt64(bound); } catch { }
                if (reasoning != null && reasoning.TryGetValue("max", out bound) && bound != null) try { view.EffortMax = Convert.ToInt64(bound); } catch { }
                AddStrings(view.EffortValues, reasoning, "values");
                if (view.EffortValues.Count == 0) AddStrings(view.EffortValues, reasoning, "allowedValues");
                // Newer adapters may expose documented candidates separately
                // while keeping the active selector probe-enforced.
                if (view.EffortValues.Count == 0) AddStrings(view.EffortValues, reasoning, "candidateValues");
                if (view.ControlType == "unknown" && view.EffortValues.Count > 0)
                {
                    string candidateType = StringValue(reasoning, "candidateControlType");
                    if (!string.IsNullOrEmpty(candidateType)) view.ControlType = candidateType;
                }
                if (view.ControlType == "numeric_budget" && view.EffortValues.Count == 0)
                {
                    AddUnique(view.EffortValues, view.EffortDefault);
                    if (view.EffortMin.HasValue) AddUnique(view.EffortValues, view.EffortMin.Value.ToString());
                    if (view.EffortMax.HasValue) AddUnique(view.EffortValues, view.EffortMax.Value.ToString());
                }
                if (string.IsNullOrEmpty(view.RealId)) view.RealId = view.Alias;
                if (string.IsNullOrEmpty(view.DisplayName)) view.DisplayName = view.RealId;
                result.Add(view);
            }
            result.Sort(delegate(ModelView a, ModelView b) { return string.Compare(a.DisplayName, b.DisplayName, StringComparison.CurrentCultureIgnoreCase); });
            return result;
        }

        private static void AddStrings(List<string> target, Dictionary<string, object> source, string key)
        {
            object raw;
            if (source == null || !source.TryGetValue(key, out raw) || raw == null) return;
            object[] values = raw as object[];
            if (values != null) foreach (object value in values) if (value != null) target.Add(value.ToString());
        }

        private static void AddUnique(List<string> target, string value)
        {
            if (!string.IsNullOrEmpty(value) && !target.Contains(value)) target.Add(value);
        }

        private static Dictionary<string, object> DictionaryValue(Dictionary<string, object> source, string key)
        {
            object raw;
            return source != null && source.TryGetValue(key, out raw) ? raw as Dictionary<string, object> : null;
        }

        private static string StringValue(Dictionary<string, object> source, string key)
        {
            object raw;
            return source != null && source.TryGetValue(key, out raw) && raw != null ? raw.ToString() : "";
        }

        private void ApplyModels(List<ModelView> models)
        {
            string selectedId = null;
            ModelView selected = modelComboBox.SelectedItem as ModelView;
            if (selected != null) selectedId = selected.RealId;
            liveModels.Clear();
            liveModels.AddRange(models);
            modelComboBox.BeginUpdate();
            modelComboBox.Items.Clear();
            foreach (ModelView model in liveModels) modelComboBox.Items.Add(model);
            modelComboBox.EndUpdate();
            modelCountLabel.Text = liveModels.Count + " chat model" + (liveModels.Count == 1 ? "" : "s") + " discovered live";
            int index = 0;
            if (!string.IsNullOrEmpty(selectedId))
                for (int i = 0; i < liveModels.Count; i++) if (liveModels[i].RealId == selectedId) { index = i; break; }
            if (modelComboBox.Items.Count > 0) modelComboBox.SelectedIndex = index;
        }

        private void ModelComboBox_SelectedIndexChanged(object sender, EventArgs e)
        {
            ModelView model = modelComboBox.SelectedItem as ModelView;
            effortComboBox.Items.Clear();
            effortComboBox.Enabled = false;
            probeEffortButton.Enabled = false;
            applyEffortButton.Enabled = false;
            if (model == null) return;
            modelMetaLabel.Text = JoinNonEmpty("  ", model.RealId, model.Provider, model.ModelType);
            if (model.ContextWindow.HasValue)
            {
                contextValueLabel.Text = FormatTokens(model.ContextWindow.Value) + " tokens";
                contextValueLabel.ForeColor = ClaudeInk;
                contextProgressBar.Value = 0;
            }
            else
            {
                contextValueLabel.Text = "Not reported by gateway";
                contextValueLabel.ForeColor = ClaudeMuted;
                contextProgressBar.Value = 0;
            }

            foreach (string value in model.EffortValues) effortComboBox.Items.Add(value);
            if (effortComboBox.Items.Count > 0)
            {
                effortComboBox.Enabled = true;
                int preferred = model.EffortValues.IndexOf(!string.IsNullOrEmpty(model.EffortSelected) ? model.EffortSelected : model.EffortDefault);
                effortComboBox.SelectedIndex = preferred >= 0 ? preferred : 0;
                probeEffortButton.Enabled = !string.IsNullOrEmpty(model.EffortField) && !string.IsNullOrEmpty(controlToken);
                applyEffortButton.Enabled = model.EffortSource == "probe" && !string.IsNullOrEmpty(controlToken);
                effortTruthLabel.Text = EffortTruth(model);
                effortTruthLabel.ForeColor = model.EffortSource == "probe" ? ClaudeSuccess : ClaudeMuted;
            }
            else
            {
                effortTruthLabel.Text = string.IsNullOrEmpty(model.EffortReason)
                    ? "No verified user-controlled effort values are advertised for this model."
                    : model.EffortReason;
                effortTruthLabel.ForeColor = ClaudeMuted;
            }
        }

        private string EffortTruth(ModelView model)
        {
            string values = string.Join(", ", model.EffortValues.ToArray());
            if (model.EffortSource == "probe")
                return (!string.IsNullOrEmpty(model.EffortSelected) ? "Applied to future requests: " + model.EffortSelected + ". " : "") +
                    "Verified values: " + values + " (" + (string.IsNullOrEmpty(model.EffortVerification) ? "behavior-observed" : model.EffortVerification) + ").";
            return "Candidate values from " + (string.IsNullOrEmpty(model.EffortSource) ? "model metadata" : model.EffortSource) + ": " + values + ". Use Verify before relying on them for this gateway.";
        }

        private void ProbeEffortButton_Click(object sender, EventArgs e)
        {
            ModelView model = modelComboBox.SelectedItem as ModelView;
            if (model == null || effortComboBox.SelectedItem == null || string.IsNullOrEmpty(model.EffortField)) return;
            string value = effortComboBox.SelectedItem.ToString();
            probeEffortButton.Enabled = false;
            effortTruthLabel.Text = "Running a real gateway conformance probe...";
            effortTruthLabel.ForeColor = ClaudeMuted;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> input = new Dictionary<string, object>();
                    input["model"] = model.Alias;
                    input["field"] = model.EffortField;
                    if (model.ControlType == "numeric_budget")
                    {
                        long numeric;
                        if (!long.TryParse(value, out numeric)) throw new Exception("The selected thinking budget is not a valid integer.");
                        input["value"] = numeric;
                    }
                    else input["value"] = value;
                    Dictionary<string, object> result = PostControlJson("/control/probe-effort", input);
                    string outcome = StringValue(result, "result");
                    string evidence = StringValue(result, "evidence");
                    bool behavioral = outcome == "behavior-observed" || outcome == "behavior_verified";
                    bool accepted = outcome == "accepted" || outcome == "schema-accepted" || behavioral;
                    bool applied = false;
                    string applyVerification = "";
                    if (accepted)
                    {
                        Dictionary<string, object> selection = new Dictionary<string, object>();
                        selection["model"] = model.Alias;
                        selection["value"] = EffortWireValue(model, value);
                        Dictionary<string, object> appliedResult = PostControlJson("/control/set-effort", selection);
                        object appliedRaw;
                        applied = appliedResult.TryGetValue("applied", out appliedRaw) && Convert.ToBoolean(appliedRaw);
                        applyVerification = StringValue(appliedResult, "verification");
                    }
                    this.BeginInvoke(new Action(delegate
                    {
                        effortTruthLabel.ForeColor = (applied || behavioral) ? ClaudeSuccess : (accepted ? ClaudeWarning : ClaudeDanger);
                        if (applied)
                            effortTruthLabel.Text = "Applied to future requests: " + value + " (" + (string.IsNullOrEmpty(applyVerification) ? outcome : applyVerification) + "). " + evidence;
                        else if (behavioral)
                            effortTruthLabel.Text = "Behavior observed for " + value + ", but the adapter did not report it applied: " + evidence;
                        else if (accepted)
                            effortTruthLabel.Text = "Schema accepted " + value + ", but it was not applied: " + evidence;
                        else
                            effortTruthLabel.Text = "Not supported for this gateway (" + outcome + "): " + evidence;
                        AppendLog("Effort probe " + model.RealId + " / " + value + ": " + outcome);
                        RefreshLiveDashboard(false);
                    }));
                }
                catch (WebException ex)
                {
                    string detail = ReadWebError(ex);
                    this.BeginInvoke(new Action(delegate { effortTruthLabel.Text = "Probe failed: " + detail; effortTruthLabel.ForeColor = ClaudeDanger; probeEffortButton.Enabled = true; }));
                }
                catch (Exception ex)
                {
                    this.BeginInvoke(new Action(delegate { effortTruthLabel.Text = "Probe failed: " + ex.Message; effortTruthLabel.ForeColor = ClaudeDanger; probeEffortButton.Enabled = true; }));
                }
            });
        }

        private void ApplyEffortButton_Click(object sender, EventArgs e)
        {
            ModelView model = modelComboBox.SelectedItem as ModelView;
            if (model == null || effortComboBox.SelectedItem == null) return;
            string value = effortComboBox.SelectedItem.ToString();
            applyEffortButton.Enabled = false;
            effortTruthLabel.Text = "Applying the verified value to future requests...";
            effortTruthLabel.ForeColor = ClaudeMuted;
            ThreadPool.QueueUserWorkItem(delegate
            {
                try
                {
                    Dictionary<string, object> input = new Dictionary<string, object>();
                    input["model"] = model.Alias;
                    input["value"] = EffortWireValue(model, value);
                    Dictionary<string, object> result = PostControlJson("/control/set-effort", input);
                    object appliedRaw;
                    bool applied = result.TryGetValue("applied", out appliedRaw) && Convert.ToBoolean(appliedRaw);
                    string verification = StringValue(result, "verification");
                    this.BeginInvoke(new Action(delegate
                    {
                        effortTruthLabel.ForeColor = applied ? ClaudeSuccess : ClaudeDanger;
                        effortTruthLabel.Text = applied
                            ? "Applied to future requests: " + value + " (" + (string.IsNullOrEmpty(verification) ? "verified" : verification) + ")."
                            : "The adapter did not apply this value.";
                        AppendLog("Effort selection " + model.RealId + " / " + value + ": " + (applied ? "applied" : "not applied"));
                        RefreshLiveDashboard(false);
                    }));
                }
                catch (WebException ex)
                {
                    string detail = ReadWebError(ex);
                    this.BeginInvoke(new Action(delegate { effortTruthLabel.Text = "Apply failed: " + detail; effortTruthLabel.ForeColor = ClaudeDanger; applyEffortButton.Enabled = true; }));
                }
                catch (Exception ex)
                {
                    this.BeginInvoke(new Action(delegate { effortTruthLabel.Text = "Apply failed: " + ex.Message; effortTruthLabel.ForeColor = ClaudeDanger; applyEffortButton.Enabled = true; }));
                }
            });
        }

        private static object EffortWireValue(ModelView model, string value)
        {
            if (model.ControlType == "numeric_budget")
            {
                long numeric;
                if (!long.TryParse(value, out numeric)) throw new Exception("The selected thinking budget is not a valid integer.");
                return numeric;
            }
            return value;
        }

        private void ApplyUsage(Dictionary<string, object> usage)
        {
            ModelView model = modelComboBox.SelectedItem as ModelView;
            if (usage == null)
            {
                usageValueLabel.Text = "Local token telemetry is not available from this adapter.";
                return;
            }
            Dictionary<string, object> scope = usage;
            Dictionary<string, object> selectedTelemetry = null;
            object modelsRaw;
            if (model != null && usage.TryGetValue("models", out modelsRaw))
            {
                object[] rows = modelsRaw as object[];
                if (rows != null)
                {
                    foreach (object raw in rows)
                    {
                        Dictionary<string, object> row = raw as Dictionary<string, object>;
                        string id = StringValue(row, "model");
                        if (id == model.RealId || id == model.Alias) { selectedTelemetry = row; break; }
                    }
                }
                if (selectedTelemetry != null)
                {
                    Dictionary<string, object> totals = DictionaryValue(selectedTelemetry, "totals");
                    scope = totals ?? selectedTelemetry;
                }
            }
            long? input = FirstLong(scope, new string[] { "inputTokens", "input_tokens", "prompt_tokens" });
            long? output = FirstLong(scope, new string[] { "outputTokens", "output_tokens", "completion_tokens" });
            long? total = FirstLong(scope, new string[] { "totalTokens", "total_tokens" });
            if (!total.HasValue && (input.HasValue || output.HasValue)) total = (input ?? 0) + (output ?? 0);
            if (!total.HasValue)
            {
                string reason = StringValue(usage, "reason");
                usageValueLabel.Text = string.IsNullOrEmpty(reason) ? "No requests recorded in this local session." : reason;
                contextProgressBar.Value = 0;
                return;
            }
            usageValueLabel.Text = "Local session: " + FormatTokens(input ?? 0) + " in  Â·  " + FormatTokens(output ?? 0) + " out  Â·  " + FormatTokens(total.Value) + " total";
            Dictionary<string, object> context = DictionaryValue(selectedTelemetry, "context");
            long? used = context == null ? null : FirstLong(context, new string[] { "usedTokens" });
            long? window = context == null ? null : FirstLong(context, new string[] { "window" });
            object utilizationRaw;
            double? utilization = null;
            if (context != null && context.TryGetValue("utilizationPercent", out utilizationRaw) && utilizationRaw != null)
                try { utilization = Convert.ToDouble(utilizationRaw); } catch { }
            if (window.HasValue && window.Value > 0)
            {
                int percent = (int)Math.Min(100, Math.Round(utilization ?? (used.HasValue ? 100.0 * used.Value / window.Value : 0)));
                contextProgressBar.Value = percent;
                contextValueLabel.Text = FormatTokens(window.Value) + " tokens" + (used.HasValue ? "  Â·  " + (utilization ?? percent).ToString("0.##") + "% last request" : "");
            }
        }

        private static long? FirstLong(Dictionary<string, object> source, string[] keys)
        {
            if (source == null) return null;
            foreach (string key in keys)
            {
                object value;
                if (source.TryGetValue(key, out value) && value != null) try { return Convert.ToInt64(value); } catch { }
            }
            object session;
            if (source.TryGetValue("session", out session)) return FirstLong(session as Dictionary<string, object>, keys);
            return null;
        }

        private static string JoinNonEmpty(string separator, params string[] values)
        {
            List<string> nonEmpty = new List<string>();
            foreach (string value in values) if (!string.IsNullOrEmpty(value)) nonEmpty.Add(value);
            return string.Join(separator, nonEmpty.ToArray());
        }

        private static string FormatTokens(long value)
        {
            if (value >= 1000000) return (value / 1000000.0).ToString("0.##") + "M";
            if (value >= 1000) return (value / 1000.0).ToString("0.#") + "K";
            return value.ToString("N0");
        }

        private static string ReadWebError(WebException ex)
        {
            try
            {
                using (HttpWebResponse response = (HttpWebResponse)ex.Response)
                using (StreamReader reader = new StreamReader(response.GetResponseStream())) return reader.ReadToEnd();
            }
            catch { return ex.Message; }
        }

        private void AuthComboBox_SelectedIndexChanged(object sender, EventArgs e)
        {
            bool isCustom = authComboBox.SelectedItem.ToString() == "custom-header";
            headerLabel.Visible = isCustom;
            headerTextBox.Visible = isCustom;

            bool isNone = authComboBox.SelectedItem.ToString() == "none";
            keyLabel.Visible = !isNone;
            keyTextBox.Visible = !isNone;
            removeSecretButton.Visible = !isNone;
        }

        private void LoadConfig()
        {
            if (File.Exists(configPath))
            {
                try
                {
                    string json = File.ReadAllText(configPath);
                    var jss = new JavaScriptSerializer();
                    currentConfig = jss.Deserialize<Dictionary<string, object>>(json);

                    if (currentConfig.ContainsKey("baseUrl"))
                        urlTextBox.Text = currentConfig["baseUrl"].ToString();

                    if (currentConfig.ContainsKey("auth"))
                    {
                        var auth = currentConfig["auth"] as Dictionary<string, object>;
                        if (auth != null)
                        {
                            if (auth.ContainsKey("kind"))
                                authComboBox.SelectedItem = auth["kind"].ToString();

                            if (auth.ContainsKey("headerName"))
                                headerTextBox.Text = auth["headerName"] != null ? auth["headerName"].ToString() : "";
                            
                            if (auth.ContainsKey("credentialRef"))
                            {
                                string credRef = auth["credentialRef"] != null ? auth["credentialRef"].ToString() : null;
                                if (!string.IsNullOrEmpty(credRef))
                                {
                                    targetCredentialName = credRef;
                                    string secret = ReadCredential(credRef);
                                    if (secret != null)
                                    {
                                        keyTextBox.Text = "";
                                        keyTextBox.Watermark("Stored in Credential Manager");
                                    }
                                }
                            }
                        }
                    }
                    if (currentConfig.ContainsKey("companion"))
                    {
                        var companion = currentConfig["companion"] as Dictionary<string, object>;
                        object enabled;
                        if (companion != null && companion.TryGetValue("enabled", out enabled))
                            companionCheckBox.Checked = Convert.ToBoolean(enabled);
                    }
                    AppendLog("Config loaded successfully.");
                }
                catch (Exception ex)
                {
                    AppendLog("Error loading config: " + ex.Message);
                    currentConfig = new Dictionary<string, object>();
                }
            }
            else
            {
                currentConfig = new Dictionary<string, object>();
                authComboBox.SelectedIndex = 0; // bearer
                urlTextBox.Text = "";
                AppendLog("No config file found. Using defaults.");
            }
        }

        private void SaveButton_Click(object sender, EventArgs e)
        {
            try
            {
                string url = urlTextBox.Text.Trim();
                if (string.IsNullOrEmpty(url))
                {
                    MessageBox.Show("Gateway Base URL is required.", "Validation Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                string kind = authComboBox.SelectedItem.ToString();
                string headerName = headerTextBox.Text.Trim();
                string secret = keyTextBox.Text;

                // Validate URL format
                try {
                    var uri = new Uri(url, UriKind.Absolute);
                    if (uri.Scheme != "http" && uri.Scheme != "https")
                        throw new Exception("Scheme must be http or https");
                    if (!string.IsNullOrEmpty(uri.UserInfo))
                        throw new Exception("The URL must not contain a username or password");
                    if (uri.Scheme == "http" && !uri.IsLoopback)
                        throw new Exception("Remote gateways must use HTTPS; HTTP is allowed only on loopback");
                } catch (Exception ex) {
                    MessageBox.Show("Invalid Base URL: " + ex.Message, "Validation Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                if (kind == "custom-header")
                {
                    var reserved = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
                        "content-length", "host", "connection", "transfer-encoding",
                        "authorization", "proxy-authorization", "x-api-key", "cookie", "set-cookie"
                    };
                    if (string.IsNullOrEmpty(headerName) || !Regex.IsMatch(headerName, "^[A-Za-z0-9!#$%&'*+.^_`|~-]+$") || reserved.Contains(headerName))
                    {
                        MessageBox.Show("Enter a valid non-reserved custom authentication header name.", "Validation Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                }

                // Compute Fingerprint
                string credRef = "ClaudeOpen/gateway/current";

                // Save Secret if provided
                if (kind != "none" && !string.IsNullOrEmpty(secret))
                {
                    if (WriteCredential(credRef, "gateway-token", secret))
                    {
                        AppendLog("Secret securely stored in Windows Credential Manager under " + credRef);
                        keyTextBox.Text = "";
                        keyTextBox.Watermark("Stored in Credential Manager");
                    }
                    else
                    {
                        MessageBox.Show("Failed to write credential to Credential Manager.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return;
                    }
                }
                else if (kind != "none" && ReadCredential(credRef) == null)
                {
                    MessageBox.Show("An API key / secret is required for the selected authentication kind.", "Validation Error", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                // Prepare configuration object
                // Preserve advanced user configuration (route overrides, model
                // facts, custom safe headers, and usage adapters) when the basic
                // Control Center fields are saved. Earlier builds recreated this
                // dictionary and silently erased those advanced settings.
                var config = currentConfig != null
                    ? new Dictionary<string, object>(currentConfig)
                    : new Dictionary<string, object>();
                config["baseUrl"] = url;
                if (!config.ContainsKey("profile")) config["profile"] = "mixed-auto";
                if (!config.ContainsKey("modelsEndpoint")) config["modelsEndpoint"] = "/v1/models";
                
                var auth = new Dictionary<string, object>();
                auth["kind"] = kind;
                auth["credentialRef"] = kind == "none" ? null : credRef;
                auth["headerName"] = kind == "custom-header" ? headerName : null;
                config["auth"] = auth;
                
                if (!config.ContainsKey("usage")) config["usage"] = new Dictionary<string, object> { { "adapter", "none" } };
                if (!config.ContainsKey("routes")) config["routes"] = new List<object>();
                if (!config.ContainsKey("modelOverrides")) config["modelOverrides"] = new Dictionary<string, object>();
                config["companion"] = new Dictionary<string, object> { { "enabled", companionCheckBox.Checked } };

                var jss = new JavaScriptSerializer();
                string json = jss.Serialize(config);
                File.WriteAllText(configPath, json, new UTF8Encoding(false));
                ProtectFile(configPath);

                currentConfig = config;
                targetCredentialName = credRef;
                AppendLog("Configuration successfully saved.");
                UpdateStatusDisplay();
                MessageBox.Show("Configuration saved.", "Success", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            catch (Exception ex)
            {
                MessageBox.Show("Failed to save config: " + ex.Message, "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void RemoveSecretButton_Click(object sender, EventArgs e)
        {
            if (string.IsNullOrEmpty(targetCredentialName))
            {
                MessageBox.Show("No saved secret to remove.", "Info", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            if (DeleteCredential(targetCredentialName))
            {
                AppendLog("Secret removed from Credential Manager: " + targetCredentialName);
                keyTextBox.Text = "";
                keyTextBox.Watermark("");
                UpdateStatusDisplay();
                MessageBox.Show("Secret removed.", "Success", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            else
            {
                MessageBox.Show("Failed to delete credential. It may already be removed.", "Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        private void UpdateStatusDisplay()
        {
            bool hasConfig = File.Exists(configPath);
            configStatusLabel.Text = "Config: " + (hasConfig ? "Valid" : "Missing");
            configStatusLabel.ForeColor = hasConfig ? ClaudeSuccess : ClaudeDanger;

            bool hasSecret = false;
            if (hasConfig && currentConfig != null && currentConfig.ContainsKey("auth"))
            {
                var auth = currentConfig["auth"] as Dictionary<string, object>;
                if (auth != null)
                {
                    string kind = auth.ContainsKey("kind") ? auth["kind"].ToString() : "none";
                    if (kind == "none")
                    {
                        hasSecret = true;
                        secretStatusLabel.Text = "Secret: None required";
                    }
                    else if (auth.ContainsKey("credentialRef"))
                    {
                        string refName = auth["credentialRef"] != null ? auth["credentialRef"].ToString() : null;
                        if (!string.IsNullOrEmpty(refName) && ReadCredential(refName) != null)
                        {
                            hasSecret = true;
                            secretStatusLabel.Text = "Secret: Securely Stored";
                        }
                        else
                        {
                            secretStatusLabel.Text = "Secret: Missing Key";
                        }
                    }
                }
            }
            else
            {
                secretStatusLabel.Text = "Secret: Unknown";
            }
            secretStatusLabel.ForeColor = hasSecret ? ClaudeSuccess : ClaudeDanger;

            if (adapterProcess != null && !adapterProcess.HasExited)
            {
                adapterStatusLabel.Text = "Adapter: Running (PID: " + adapterProcess.Id + ")\nPort: " + activePort;
                adapterStatusLabel.ForeColor = ClaudeSuccess;
            }
            else
            {
                adapterStatusLabel.Text = "Adapter: Stopped";
                adapterStatusLabel.ForeColor = ClaudeDanger;
            }
        }

        private void LaunchButton_Click(object sender, EventArgs e)
        {
            if (adapterProcess != null && !adapterProcess.HasExited)
            {
                // Toggle stop
                StopProcesses();
                launchButton.Text = "Launch Claude Open";
                launchButton.BackColor = ClaudeTerracotta;
                return;
            }

            if (!File.Exists(configPath))
            {
                MessageBox.Show("Please save configuration first.", "Missing Configuration", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            try
            {
                stopping = false;
                clientToken = CreateLocalToken();
                if (StartAdapter(0) && PollReadiness())
                {
                    AppendLog("Adapter deep health and inference checks passed.");
                    if (LaunchClaudeClient())
                    {
                        launchButton.Text = "Stop Claude Open";
                        launchButton.BackColor = ClaudeDanger;
                        RefreshLiveDashboard(false);
                    }
                    else StopProcesses();
                }
                else
                {
                    AppendLog("Adapter failed to respond in time. Check adapter.log.");
                    StopProcesses();
                }

                UpdateStatusDisplay();
            }
            catch (Exception ex)
            {
                AppendLog("Launch failure: " + ex.Message);
                MessageBox.Show("Failed to launch adapter: " + ex.Message, "Launch Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                StopProcesses();
            }
        }

        private bool StartAdapter(int preferredPort)
        {
            AppendLog("Starting loopback adapter...");
            string installRoot = FindInstallRoot();
            string bundledAdapter = Path.Combine(installRoot, "adapter", "adapter.mjs");
            string mainJsPath = File.Exists(bundledAdapter)
                ? bundledAdapter
                : Path.Combine(installRoot, "apps", "adapter-server", "src", "main.js");
            if (!File.Exists(mainJsPath))
                throw new FileNotFoundException("Cannot locate the Claude Open adapter under: " + installRoot);

            string bundledNode = Path.Combine(installRoot, "runtime", "node.exe");
            string nodeExe = File.Exists(bundledNode) ? bundledNode : "node"; // PATH fallback is development-only
            string runtimeFile = Path.Combine(runtimeDir, "runtime.json");
            try { if (File.Exists(runtimeFile)) File.Delete(runtimeFile); } catch {}

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodeExe;
            psi.Arguments = "\"" + mainJsPath + "\"";
            psi.WorkingDirectory = installRoot;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.EnvironmentVariables["CLAUDE_OPEN_PORT"] = preferredPort.ToString();
            psi.EnvironmentVariables["CLAUDE_OPEN_RUNTIME_DIR"] = runtimeDir;
            psi.EnvironmentVariables["CLAUDE_OPEN_CONFIG_DIR"] = appDataDir;
            psi.EnvironmentVariables["CLAUDE_OPEN_CLIENT_TOKEN"] = clientToken;
            if (companionCheckBox != null && companionCheckBox.Checked)
                psi.EnvironmentVariables["CLAUDE_OPEN_COMPANION"] = "1";
            string widgetDir = Path.Combine(installRoot, "client", "resources", "ion-dist", "assets", "v1");
            if (Directory.Exists(widgetDir))
                psi.EnvironmentVariables["CLAUDE_OPEN_WIDGET_DIR"] = widgetDir;

            string logFile = Path.Combine(runtimeDir, "adapter.log");
            adapterProcess = new Process();
            adapterProcess.StartInfo = psi;
            adapterProcess.OutputDataReceived += delegate(object s, DataReceivedEventArgs ev) {
                if (ev.Data != null) try { File.AppendAllText(logFile, ev.Data + Environment.NewLine); } catch {}
            };
            adapterProcess.ErrorDataReceived += delegate(object s, DataReceivedEventArgs ev) {
                if (ev.Data != null) try { File.AppendAllText(logFile, "[ERROR] " + ev.Data + Environment.NewLine); } catch {}
            };
            if (!adapterProcess.Start()) return false;
            adapterProcess.BeginOutputReadLine();
            adapterProcess.BeginErrorReadLine();
            lastAdapterStart = DateTime.UtcNow;
            AppendLog("Adapter launched (PID " + adapterProcess.Id + "). Waiting for runtime state...");
            return true;
        }

        private string FindInstallRoot()
        {
            string cursor = Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
            for (int i = 0; i < 5; i++)
            {
                if (File.Exists(Path.Combine(cursor, "adapter", "adapter.mjs")) ||
                    File.Exists(Path.Combine(cursor, "apps", "adapter-server", "src", "main.js"))) return cursor;
                DirectoryInfo parent = Directory.GetParent(cursor);
                if (parent == null) break;
                cursor = parent.FullName;
            }
            return Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory);
        }

        private void ReadRuntimeState()
        {
            string runtimeFile = Path.Combine(runtimeDir, "runtime.json");
            if (!File.Exists(runtimeFile)) return;
            var rt = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(runtimeFile));
            object value;
            if (rt.TryGetValue("port", out value)) activePort = Convert.ToInt32(value);
            if (rt.TryGetValue("clientToken", out value) && value != null) clientToken = value.ToString();
            if (rt.TryGetValue("controlToken", out value) && value != null) controlToken = value.ToString();
            if (rt.TryGetValue("companion", out value) && value != null)
            {
                var companion = value as Dictionary<string, object>;
                object companionValue;
                if (companion != null && companion.TryGetValue("enabled", out companionValue) && Convert.ToBoolean(companionValue))
                {
                    if (companion.TryGetValue("port", out companionValue)) companionPort = Convert.ToInt32(companionValue);
                    if (companion.TryGetValue("pairingCode", out companionValue) && companionValue != null) companionPairingCode = companionValue.ToString();
                    if (companion.TryGetValue("pairingExpiresAt", out companionValue) && companionValue != null) companionPairingExpiresAt = companionValue.ToString();
                }
            }
        }

        private void CompanionSetupButton_Click(object sender, EventArgs e)
        {
            if (companionCheckBox == null || !companionCheckBox.Checked)
            {
                MessageBox.Show("Enable the mobile companion checkbox, save configuration, and launch Claude Open first.", "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (adapterProcess == null || adapterProcess.HasExited)
            {
                MessageBox.Show("Launch Claude Open first. The companion exists only while Claude Open is running.", "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            ReadRuntimeState();
            if (companionPort <= 0 || string.IsNullOrEmpty(companionPairingCode))
            {
                MessageBox.Show("The companion did not start. Check adapter.log for a redacted startup error, then restart Claude Open.", "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            string localUrl = "http://127.0.0.1:" + companionPort + "/";
            string tailscaleCommand = "tailscale serve --yes http://127.0.0.1:" + companionPort;
            string message =
                "PAIRING CODE\r\n" + companionPairingCode + "\r\n\r\n" +
                "Expires: " + companionPairingExpiresAt + "\r\n\r\n" +
                "Yes: open a local preview on this PC.\r\n" +
                "No: copy the recommended Tailscale Serve command. Run it in an elevated PowerShell, then open the private HTTPS URL it displays on a phone signed into the same tailnet.\r\n\r\n" +
                "Never expose the companion port directly to the LAN or internet.";
            DialogResult result = MessageBox.Show(message, "Mobile Companion", MessageBoxButtons.YesNoCancel, MessageBoxIcon.Information);
            if (result == DialogResult.Yes)
            {
                try { Process.Start(new ProcessStartInfo(localUrl) { UseShellExecute = true }); }
                catch (Exception ex) { MessageBox.Show("Could not open the local preview: " + ex.Message, "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            }
            else if (result == DialogResult.No)
            {
                try
                {
                    Clipboard.SetText(tailscaleCommand);
                    MessageBox.Show("The Tailscale Serve command was copied. It contains only the loopback port, not the pairing code or gateway key.", "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Information);
                }
                catch (Exception ex) { MessageBox.Show("Could not copy the command: " + ex.Message, "Mobile Companion", MessageBoxButtons.OK, MessageBoxIcon.Warning); }
            }
        }

        private string CreateLocalToken()
        {
            byte[] bytes = new byte[32];
            using (RandomNumberGenerator rng = RandomNumberGenerator.Create()) rng.GetBytes(bytes);
            return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        }

        private bool PollReadiness()
        {
            // First wait only for the cheap local liveness endpoint. Do not
            // repeatedly invoke deep health: each deep call performs real
            // discovery and inference and can cost time/tokens.
            bool live = false;
            for (int i = 0; i < 40; i++)
            {
                if (adapterProcess == null || adapterProcess.HasExited) return false;
                try
                {
                    ReadRuntimeState();
                    if (activePort <= 0 || string.IsNullOrEmpty(clientToken)) throw new Exception("runtime state not ready");
                    string url = "http://127.0.0.1:" + activePort + "/health";
                    HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                    request.Timeout = 750;
                    using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                    {
                        if (response.StatusCode == HttpStatusCode.OK) { live = true; break; }
                    }
                }
                catch
                {
                    Thread.Sleep(250);
                }
            }
            if (!live) return false;

            // One real deep check with a realistic timeout.
            try
            {
                HttpWebRequest deep = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + activePort + "/health/deep");
                deep.Timeout = 120000;
                deep.Headers[HttpRequestHeader.Authorization] = "Bearer " + clientToken;
                using (HttpWebResponse response = (HttpWebResponse)deep.GetResponse())
                using (var reader = new StreamReader(response.GetResponseStream()))
                {
                    var state = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(reader.ReadToEnd());
                    object healthy;
                    object inference;
                    if (!state.TryGetValue("healthy", out healthy) || !Convert.ToBoolean(healthy)) return false;
                    if (!state.TryGetValue("inference", out inference)) return false;
                    var check = inference as Dictionary<string, object>;
                    return check != null && check.ContainsKey("status") && check["status"].ToString() == "pass";
                }
            }
            catch (Exception ex)
            {
                AppendLog("Deep readiness failed: " + ex.Message);
                return false;
            }
        }

        // The upstream-overloaded aliases observed live. The launcher must never
        // hoist one of these to the client default (first inferenceModels entry).
        // This is guidance only: overloaded models are still OFFERED, just not
        // chosen as the default. Mirrors selectDefaultModel's unhealthy set in
        // packages/identity-harness/src/index.js.
        private static readonly string[] KnownOverloadedModels = {
            "claude-haiku-4-5",
            "claude-sonnet-4-6",
            "claude-sonnet-5",
            "gemini-3-flash-v2",
            "minimax-m3",
            "gpt-5.4"
        };

        // Anthropic opus aliases preferred as the healthy default, newest first.
        // Mirrors OPUS_PREFERENCE_ORDER in the harness.
        private static readonly string[] OpusPreferenceOrder = {
            "claude-opus-4-8",
            "claude-opus-4-7",
            "claude-opus-4-6",
            "claude-opus-4-5"
        };

        // Pure default-selection mirror of harness selectDefaultModel(). Kept in
        // C# so the launch path does not need a node round-trip just to pick the
        // default; the harness function is the canonical, unit-tested contract.
        internal static string SelectDefaultModel(List<string> modelIds, IEnumerable<string> unhealthyIds)
        {
            if (modelIds == null || modelIds.Count == 0) return null;
            HashSet<string> unhealthy = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            if (unhealthyIds != null) foreach (string id in unhealthyIds) if (id != null) unhealthy.Add(id);

            // 1. Newest available healthy opus alias.
            foreach (string preferred in OpusPreferenceOrder)
                foreach (string id in modelIds)
                    if (string.Equals(id, preferred, StringComparison.OrdinalIgnoreCase) && !unhealthy.Contains(id))
                        return id;

            // 2. First healthy model.
            foreach (string id in modelIds)
                if (!unhealthy.Contains(id)) return id;

            // 3. Last resort: everything is unhealthy; keep the first model.
            return modelIds[0];
        }

        private bool LaunchClaudeClient()
        {
            // (a) Discover the live catalog from the running adapter. This is the
            // same authenticated /v1/models call the dashboard uses; every alias,
            // label, and route comes from the gateway, never from a literal here.
            AppendLog("Discovering gateway models for 3P activation...");
            List<ModelView> models;
            try
            {
                Dictionary<string, object> payload = GetLocalJson("/v1/models", false);
                models = ParseModels(payload);
            }
            catch (Exception ex)
            {
                AppendLog("Could not read /v1/models before launch: " + ex.Message);
                MessageBox.Show("The local adapter did not return a model catalog. Launch aborted.\n\n" + ex.Message, "Model Discovery Failed", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            if (models.Count == 0)
            {
                AppendLog("Gateway returned an empty model catalog; refusing to activate 3P with no models.");
                MessageBox.Show("Your gateway returned no models, so Claude Open cannot activate a third-party profile.", "No Models", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }
            // Keep the dashboard model picker in sync with what we are about to write.
            ApplyModels(models);

            // (b) Stage all chat aliases for default/tier selection. Production
            // config uses native discovery and intentionally omits a static list.
            // (name = alias, label = display) and (c) choose a HEALTHY default.
            List<string> aliasOrder = new List<string>();
            foreach (ModelView m in models) aliasOrder.Add(m.Alias);
            string defaultAlias = SelectDefaultModel(aliasOrder, KnownOverloadedModels);
            AppendLog("Discovered " + models.Count + " model(s). Default = " + defaultAlias +
                (System.Array.IndexOf(KnownOverloadedModels, defaultAlias) >= 0 ? " (all healthy models overloaded; using first)" : ""));

            // (d) Write the FLAT 3P config-library via the tested node producer.
            string configId;
            if (!WriteThirdPartyConfig(models, defaultAlias, out configId))
                return false; // WriteThirdPartyConfig already logged + messaged.
            AppendLog("3P profile activated (config " + configId + ", deploymentMode=3p).");

            // (e) Launch the copied, still Anthropic-signed client through Claude
            // Open's sparse package identity. The executable itself is never
            // renamed or modified.
            bool cowork;
            AppendLog("Locating the signed Claude Open runtime...");
            string claudeExePath = LocateClaudeExe(out cowork);

            if (string.IsNullOrEmpty(claudeExePath) || !File.Exists(claudeExePath))
            {
                AppendLog("Failed to locate client\\claude.exe in the Claude Open installation.");
                MessageBox.Show("The Claude Open runtime is incomplete. Rerun the installer so it can copy and verify the official signed client.", "Client Not Found", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return false;
            }

            if (cowork)
                AppendLog("Host: signed client under Claude Open sparse identity (Cowork available): " + claudeExePath);
            else
                AppendLog("Claude Open runtime identity is not registered; Cowork cannot launch safely.");

            try
            {
                if (!cowork) throw new Exception("Claude Open runtime package identity is not registered");
                clientProcess = ActivatePackagedRuntime(claudeExePath);
                AppendLog("Claude client launched (PID " + clientProcess.Id + ")");
                return true;
            }
            catch (Exception ex)
            {
                AppendLog("Error launching client: " + ex.Message);
                return false;
            }
        }

        // Shell out to the tested node producer (scripts/write-3p-config.mjs) via
        // the bundled node to write configLibrary/<uuid>.json + _meta.json +
        // claude_desktop_config.json(deploymentMode:3p) into profilePath. We reuse
        // the harness rather than reimplementing the flat contract in C#.
        private bool WriteThirdPartyConfig(List<ModelView> models, string defaultAlias, out string configurationId)
        {
            configurationId = "";
            string installRoot = FindInstallRoot();
            string shim = Path.Combine(installRoot, "scripts", "write-3p-config.mjs");
            if (!File.Exists(shim))
            {
                AppendLog("Cannot locate scripts/write-3p-config.mjs under: " + installRoot);
                MessageBox.Show("The 3P config producer (scripts/write-3p-config.mjs) is missing from the install.", "Producer Missing", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            string bundledNode = Path.Combine(installRoot, "runtime", "node.exe");
            string nodeExe = File.Exists(bundledNode) ? bundledNode : "node"; // PATH fallback is development-only
            string harnessRoot = Path.Combine(runtimeDir, "harness");
            try { if (!Directory.Exists(harnessRoot)) Directory.CreateDirectory(harnessRoot); } catch {}

            // Write the { id, display_name } model records the producer expects.
            string modelsFile = Path.Combine(runtimeDir, "models.json");
            List<Dictionary<string, object>> records = new List<Dictionary<string, object>>();
            foreach (ModelView m in models)
            {
                Dictionary<string, object> record = new Dictionary<string, object>();
                record["id"] = m.Alias;
                record["display_name"] = string.IsNullOrEmpty(m.DisplayName) ? m.Alias : m.DisplayName;
                records.Add(record);
            }
            try
            {
                string json = new JavaScriptSerializer().Serialize(records);
                File.WriteAllText(modelsFile, json, new UTF8Encoding(false));
            }
            catch (Exception ex)
            {
                AppendLog("Failed to stage models.json: " + ex.Message);
                return false;
            }

            // Build the write-3p-config argv. Uses the LIVE bound adapter port
            // (activePort) - the config is written AFTER PollReadiness confirmed
            // the adapter is listening (activePort>0) and BEFORE the client
            // launches. FIX 3(a): also passes --assign-family-tiers + --unhealthy
            // so anthropicFamilyTier tags are written and the client's per-tier
            // probes (haiku|sonnet|opus) resolve to a HEALTHY model instead of the
            // built-in overloaded claude-haiku-4-5.
            List<string> argv = BuildWrite3pArgs(
                shim, harnessRoot, profilePath, activePort, clientToken,
                modelsFile, defaultAlias, KnownOverloadedModels);

            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = nodeExe;
                psi.Arguments = BuildArguments(argv);
                psi.WorkingDirectory = installRoot;
                psi.UseShellExecute = false;
                psi.CreateNoWindow = true;
                psi.RedirectStandardOutput = true;
                psi.RedirectStandardError = true;
                using (Process p = Process.Start(psi))
                {
                    string stdout = p.StandardOutput.ReadToEnd();
                    string stderr = p.StandardError.ReadToEnd();
                    p.WaitForExit();
                    if (p.ExitCode != 0)
                    {
                        AppendLog("write-3p-config failed (exit " + p.ExitCode + "): " + (string.IsNullOrEmpty(stderr) ? stdout : stderr));
                        MessageBox.Show("Writing the third-party profile failed.\n\n" + (string.IsNullOrEmpty(stderr) ? stdout : stderr), "3P Activation Failed", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return false;
                    }
                    try
                    {
                        Dictionary<string, object> result = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(stdout);
                        if (result != null && result.ContainsKey("configurationId") && result["configurationId"] != null)
                            configurationId = result["configurationId"].ToString();
                    }
                    catch { }
                }
            }
            catch (Exception ex)
            {
                AppendLog("Failed to invoke the 3P config producer: " + ex.Message);
                MessageBox.Show("Could not run the 3P config producer via node.\n\n" + ex.Message, "3P Activation Error", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return false;
            }
            return true;
        }

        // Pure argv builder for scripts/write-3p-config.mjs. Extracted so it is
        // unit-testable (LauncherSmokeTest) without launching node. Flag names are
        // verified against scripts/write-3p-config.mjs parseArgs():
        //   --production, --harness-root, --user-data, --base-url, --token,
        //   --models, --assign-family-tiers, --unhealthy <csv>, --default,
        //   --config-name.
        //
        // FIX 1(a): --base-url ALWAYS uses the LIVE activePort passed in (never a
        // fixed literal), so the client 3P config points at the ephemeral port the
        // adapter actually bound this launch.
        // FIX 3(a): --assign-family-tiers + --unhealthy <comma-joined overloaded>
        // are ALWAYS emitted so the client writes anthropicFamilyTier tags and its
        // tier resolvers land on a healthy model; --default is the healthy opus.
        internal static List<string> BuildWrite3pArgs(
            string shim, string harnessRoot, string profilePath, int activePort,
            string clientToken, string modelsFile, string defaultAlias,
            IEnumerable<string> unhealthyModels)
        {
            List<string> argv = new List<string>();
            argv.Add(shim);
            argv.Add("--production");
            argv.Add("--harness-root"); argv.Add(harnessRoot);
            argv.Add("--user-data"); argv.Add(profilePath);
            argv.Add("--base-url"); argv.Add("http://127.0.0.1:" + activePort);
            argv.Add("--token"); argv.Add(clientToken);
            argv.Add("--models"); argv.Add(modelsFile);
            // Always request family-tier tagging so the client's per-tier probe
            // resolves to a healthy model instead of the overloaded built-in tier.
            argv.Add("--assign-family-tiers");
            argv.Add("--model-discovery");
            List<string> overloaded = new List<string>();
            if (unhealthyModels != null)
                foreach (string id in unhealthyModels)
                    if (!string.IsNullOrEmpty(id)) overloaded.Add(id);
            argv.Add("--unhealthy"); argv.Add(string.Join(",", overloaded.ToArray()));
            if (!string.IsNullOrEmpty(defaultAlias)) { argv.Add("--default"); argv.Add(defaultAlias); }
            argv.Add("--config-name"); argv.Add("Claude Open");
            return argv;
        }

        // Quote an argv list for a native process (csc / .NET Framework has no
        // ProcessStartInfo.ArgumentList). Each argument is wrapped in double
        // quotes with embedded quotes/backslashes escaped per Windows rules.
        private static string BuildArguments(List<string> args)
        {
            StringBuilder sb = new StringBuilder();
            for (int i = 0; i < args.Count; i++)
            {
                if (i > 0) sb.Append(' ');
                sb.Append(QuoteArgument(args[i]));
            }
            return sb.ToString();
        }

        private static string QuoteArgument(string arg)
        {
            if (arg == null) arg = "";
            if (arg.Length > 0 && arg.IndexOfAny(new char[] { ' ', '\t', '"', '\\' }) < 0)
                return arg;
            StringBuilder sb = new StringBuilder();
            sb.Append('"');
            int backslashes = 0;
            foreach (char c in arg)
            {
                if (c == '\\') { backslashes++; continue; }
                if (c == '"')
                {
                    sb.Append('\\', backslashes * 2 + 1);
                    backslashes = 0;
                    sb.Append('"');
                    continue;
                }
                sb.Append('\\', backslashes);
                backslashes = 0;
                sb.Append(c);
            }
            sb.Append('\\', backslashes * 2);
            sb.Append('"');
            return sb.ToString();
        }

        // Locate the installer-owned copy of the official executable. The
        // installer keeps its filename and Authenticode signature intact and
        // registers this path as the Runtime app in Claude Open's sparse MSIX.
        private string LocateClaudeExe(out bool coworkCapable)
        {
            string installRoot = FindInstallRoot();
            string client = Path.Combine(installRoot, "client", "claude.exe");
            coworkCapable = File.Exists(client) && !string.IsNullOrEmpty(ResolveClaudeOpenPackageFamily());
            return File.Exists(client) ? client : null;
        }

        private string ResolveClaudeOpenPackageFamily()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell";
                psi.Arguments = "-NoProfile -NonInteractive -Command \"Get-AppxPackage -Name ClaudeOpen | Select-Object -First 1 -ExpandProperty PackageFamilyName\"";
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string value = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit();
                    return p.ExitCode == 0 ? value : null;
                }
            }
            catch { return null; }
        }

        private Process ActivatePackagedRuntime(string expectedExe)
        {
            string family = ResolveClaudeOpenPackageFamily();
            if (string.IsNullOrEmpty(family)) throw new Exception("ClaudeOpen sparse package is not registered");

            string previous = Environment.GetEnvironmentVariable("CLAUDE_USER_DATA_DIR", EnvironmentVariableTarget.User);
            // A matching value can only be residue from an interrupted prior
            // activation window. Treat it as stale and clear it after this run.
            string restore = string.Equals(previous, profilePath, StringComparison.OrdinalIgnoreCase) ? null : previous;
            if (!string.IsNullOrEmpty(previous) && restore != null)
                throw new Exception("CLAUDE_USER_DATA_DIR is already set for this Windows user; remove it before launching Claude Open");

            DateTime startedAfter = DateTime.Now.AddSeconds(-1);
            try
            {
                // AppX activation does not accept a private environment block.
                // Supply the isolated profile only for the short activation
                // window and restore the user's prior value in finally.
                Environment.SetEnvironmentVariable("CLAUDE_USER_DATA_DIR", profilePath, EnvironmentVariableTarget.User);
                ProcessStartInfo activation = new ProcessStartInfo("explorer.exe", "shell:AppsFolder\\" + family + "!Runtime");
                activation.UseShellExecute = true;
                Process.Start(activation);

                DateTime deadline = DateTime.Now.AddSeconds(20);
                do
                {
                    foreach (Process process in Process.GetProcessesByName("claude"))
                    {
                        try
                        {
                            if (string.Equals(process.MainModule.FileName, expectedExe, StringComparison.OrdinalIgnoreCase) &&
                                process.StartTime >= startedAfter)
                                return process;
                        }
                        catch { process.Dispose(); }
                    }
                    Thread.Sleep(250);
                } while (DateTime.Now < deadline);
                throw new Exception("packaged runtime activation timed out");
            }
            finally
            {
                Environment.SetEnvironmentVariable("CLAUDE_USER_DATA_DIR", restore, EnvironmentVariableTarget.User);
            }
        }

        // Documented fallback ONLY: if the AppX family name cannot be resolved
        // dynamically (Get-AppxPackage unavailable / package temporarily absent),
        // fall back to the family observed for the signed Claude package. This is
        // a last-resort value and is never preferred over the live resolution.
        private const string ClaudePackageFamilyFallback = "Claude_pzs8sxrjxfjjc";

        // Is the current process running with an elevated (Administrator) token?
        private static bool IsProcessElevated()
        {
            try
            {
                using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
                {
                    WindowsPrincipal principal = new WindowsPrincipal(identity);
                    return principal.IsInRole(WindowsBuiltInRole.Administrator);
                }
            }
            catch { return false; }
        }

        // Resolve the Claude AppX package family name dynamically. Returns the
        // fallback constant if the live lookup yields nothing.
        private string ResolveClaudePackageFamily()
        {
            try
            {
                ProcessStartInfo psi = new ProcessStartInfo();
                psi.FileName = "powershell";
                psi.Arguments = "-NoProfile -NonInteractive -Command \"Get-AppxPackage -Name Claude | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty PackageFamilyName\"";
                psi.UseShellExecute = false;
                psi.RedirectStandardOutput = true;
                psi.CreateNoWindow = true;
                using (Process p = Process.Start(psi))
                {
                    string outStr = p.StandardOutput.ReadToEnd().Trim();
                    p.WaitForExit();
                    if (!string.IsNullOrEmpty(outStr) && IsSafeFamilyName(outStr)) return outStr;
                }
            }
            catch (Exception ex)
            {
                AppendLog("Could not resolve Claude package family dynamically: " + ex.Message);
            }
            AppendLog("Falling back to documented Claude package family: " + ClaudePackageFamilyFallback);
            return ClaudePackageFamilyFallback;
        }

        // Mirror of the JS SAFE_FAMILY_NAME guard (packages/identity-harness) so
        // an unexpected family value can never be spliced into a native command.
        private static bool IsSafeFamilyName(string family)
        {
            if (string.IsNullOrEmpty(family)) return false;
            int underscores = 0;
            bool sawTailChar = false;
            for (int i = 0; i < family.Length; i++)
            {
                char c = family[i];
                if (c == '_') { underscores++; sawTailChar = false; continue; }
                bool ok = (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
                if (underscores == 0) ok = ok || c == '.';
                if (!ok) return false;
                if (underscores == 1) sawTailChar = true;
            }
            return underscores == 1 && sawTailChar;
        }

        // Query current LoopbackExempt entries and decide whether `family` is
        // already present. Mirrors identity-harness isFamilyLoopbackExempt():
        // whole-token, case-insensitive match on any `Name:` line.
        private static bool IsFamilyLoopbackExempt(string cnisOutput, string family)
        {
            if (string.IsNullOrEmpty(cnisOutput) || string.IsNullOrEmpty(family)) return false;
            string target = family.Trim().ToLowerInvariant();
            if (target.Length == 0) return false;
            string[] lines = cnisOutput.Replace("\r\n", "\n").Split('\n');
            foreach (string line in lines)
            {
                string trimmed = line.Trim();
                if (trimmed.Length < 5) continue;
                if (!trimmed.StartsWith("Name:", StringComparison.OrdinalIgnoreCase)) continue;
                string value = trimmed.Substring(5).Trim();
                if (value.ToLowerInvariant() == target) return true;
            }
            return false;
        }

        private static string RunCheckNetIsolation(string arguments, bool elevated)
        {
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = "CheckNetIsolation";
            psi.Arguments = arguments;
            psi.CreateNoWindow = true;
            if (elevated)
            {
                // A UAC-elevated relaunch cannot redirect stdout, so we cannot
                // read the child's output. UseShellExecute + runas is required.
                psi.UseShellExecute = true;
                psi.Verb = "runas";
                psi.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process p = Process.Start(psi)) { p.WaitForExit(); }
                return null;
            }
            psi.UseShellExecute = false;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            using (Process p = Process.Start(psi))
            {
                string outStr = p.StandardOutput.ReadToEnd();
                p.StandardError.ReadToEnd();
                p.WaitForExit();
                return outStr;
            }
        }

        // Ensure the genuine WindowsApps Claude client (AppContainer-sandboxed)
        // is permitted to reach our loopback adapter. Without a per-package
        // LoopbackExempt entry the client's 3P fetch to 127.0.0.1 is blocked and
        // times out. Only meaningful for the genuine WindowsApps host; the copied
        // fallback client runs OUTSIDE an AppContainer, so we skip it there.
        //
        // The exemption is per-package and is shared with normal Claude. That is
        // unavoidable and harmless: it only ALLOWS loopback, which normal Claude
        // does not use.
        private void EnsureLoopbackExemption(bool genuineWindowsAppsHost)
        {
            if (!genuineWindowsAppsHost)
            {
                AppendLog("Loopback exemption: skipped (copied client is not AppContainer-sandboxed).");
                return;
            }

            string family = ResolveClaudePackageFamily();
            if (!IsSafeFamilyName(family))
            {
                AppendLog("Loopback exemption: resolved family name is unsafe; aborting registration: " + family);
                return;
            }
            string addArgs = "LoopbackExempt -a -n=" + family;

            try
            {
                string current = RunCheckNetIsolation("LoopbackExempt -s", false);
                if (IsFamilyLoopbackExempt(current, family))
                {
                    AppendLog("Loopback exemption already present for " + family + ".");
                    return;
                }

                AppendLog("Loopback exemption missing for " + family + "; registering (" + addArgs + ").");

                if (IsProcessElevated())
                {
                    RunCheckNetIsolation(addArgs, false);
                }
                else
                {
                    // Relaunch JUST this one command elevated via a UAC prompt.
                    AppendLog("Elevation required to register the loopback exemption; prompting (UAC).");
                    try
                    {
                        RunCheckNetIsolation(addArgs, true);
                    }
                    catch (Exception ex)
                    {
                        // User declined UAC or elevation failed. Never silently
                        // no-op: surface the exact command to run manually.
                        AppendLog("Elevated registration did not complete: " + ex.Message);
                        MessageBox.Show(
                            "Claude Open needs a one-time loopback exemption so the sandboxed Claude client can reach the local adapter.\r\n\r\n" +
                            "Run this once in an elevated (Administrator) PowerShell / Command Prompt:\r\n\r\n" +
                            "    CheckNetIsolation " + addArgs + "\r\n\r\n" +
                            "Then relaunch Claude Open.",
                            "Loopback Exemption Required",
                            MessageBoxButtons.OK, MessageBoxIcon.Warning);
                        return;
                    }
                }

                // Verify the exemption is now present and log the result.
                string after = RunCheckNetIsolation("LoopbackExempt -s", false);
                if (IsFamilyLoopbackExempt(after, family))
                    AppendLog("Loopback exemption verified for " + family + ".");
                else
                    AppendLog("WARNING: loopback exemption for " + family + " not confirmed after registration. If the client cannot reach the adapter, run: CheckNetIsolation " + addArgs);
            }
            catch (Exception ex)
            {
                AppendLog("Loopback exemption check failed: " + ex.Message + ". Manual command: CheckNetIsolation " + addArgs);
            }
        }

        private void ProcessMonitorTimer_Tick(object sender, EventArgs e)
        {
            bool statusChanged = false;

            if (adapterProcess != null && !adapterProcess.HasExited &&
                (DateTime.UtcNow - lastDashboardRefresh).TotalSeconds >= 10)
                RefreshLiveDashboard(false);

            if (adapterProcess != null)
            {
                if (adapterProcess.HasExited)
                {
                    AppendLog("WARNING: Loopback adapter process exited unexpectedly!");
                    
                    // Restart only the adapter on the same port/token. Relaunching
                    // the full client would duplicate Electron processes and
                    // orphan the original window.
                    if (!stopping && restartAttempts < 5)
                    {
                        restartAttempts++;
                        AppendLog("Attempting adapter recovery " + restartAttempts + "/5...");
                        try
                        {
                            int oldPort = activePort;
                            adapterProcess = null;
                            if (StartAdapter(oldPort) && PollReadiness())
                            {
                                AppendLog("Adapter recovery succeeded without relaunching Claude.");
                                if ((DateTime.UtcNow - lastAdapterStart).TotalSeconds > 30) restartAttempts = 0;
                            }
                        }
                        catch (Exception ex) { AppendLog("Adapter recovery failed: " + ex.Message); }
                    }
                    else
                    {
                        StopProcesses();
                    }
                    statusChanged = true;
                }
            }

            // Packaged Electron can return a short-lived activation wrapper.
            // Do not interpret that wrapper exiting as the user closing Claude.

            if (statusChanged)
            {
                UpdateStatusDisplay();
                launchButton.Text = "Launch Claude Open";
                launchButton.BackColor = ClaudeTerracotta;
            }
        }

        private void StopProcesses()
        {
            stopping = true;
            if (clientProcess != null)
            {
                try {
                    if (!clientProcess.HasExited)
                    {
                        AppendLog("Closing client PID " + clientProcess.Id + "...");
                        clientProcess.Kill();
                    }
                } catch {}
                clientProcess = null;
            }

            // FIX #5: the tracked handle above may be a short-lived MSIX/Electron
            // activation wrapper whose PID already exited while the REAL client
            // keeps running under a different PID. Terminate the actual client
            // scoped to OUR isolated profile so Stop never leaves it running -- and
            // never touches normal Claude (which uses a different user-data dir).
            KillClientByProfile();

            if (adapterProcess != null)
            {
                try {
                    if (!adapterProcess.HasExited)
                    {
                        AppendLog("Stopping adapter PID " + adapterProcess.Id + "...");
                        adapterProcess.Kill();
                    }
                } catch {}
                adapterProcess = null;
            }

            // Retire all per-run local bearer/control/pairing material as soon
            // as the owning adapter stops. The next launch creates fresh values.
            try
            {
                string runtimeFile = Path.Combine(runtimeDir, "runtime.json");
                if (File.Exists(runtimeFile)) File.Delete(runtimeFile);
            }
            catch (Exception ex) { AppendLog("Warning: could not remove retired runtime state: " + ex.Message); }

            activePort = 0;
            clientToken = "";
            controlToken = "";
            companionPort = 0;
            companionPairingCode = "";
            companionPairingExpiresAt = "";
            liveModels.Clear();
            if (modelComboBox != null) modelComboBox.Items.Clear();
            if (modelCountLabel != null) modelCountLabel.Text = "Launch to discover models";
            if (usageValueLabel != null) usageValueLabel.Text = "Session usage: waiting for local telemetry";
            if (contextValueLabel != null) contextValueLabel.Text = "Not reported";
            if (contextProgressBar != null) contextProgressBar.Value = 0;
            if (effortComboBox != null) { effortComboBox.Items.Clear(); effortComboBox.Enabled = false; }
            if (probeEffortButton != null) probeEffortButton.Enabled = false;
            if (applyEffortButton != null) applyEffortButton.Enabled = false;
            UpdateStatusDisplay();
        }

        // FIX #5: terminate the real Claude client process(es) that belong to OUR
        // isolated profile, identified by CLAUDE_USER_DATA_DIR / --user-data /
        // command-line reference to profilePath. This is strictly profile-scoped:
        // normal Claude uses a different user-data dir, so it is never matched.
        // Uses WMI (Win32_Process) so we can inspect each candidate's command line.
        private void KillClientByProfile()
        {
            if (string.IsNullOrEmpty(profilePath)) return;
            string needle;
            try { needle = Path.GetFullPath(profilePath).TrimEnd('\\'); }
            catch { needle = profilePath; }
            if (string.IsNullOrEmpty(needle)) return;

            try
            {
                // Snapshot all Claude client processes with their parent + command line.
                string wql = "SELECT ProcessId, ParentProcessId, Name, CommandLine FROM Win32_Process " +
                             "WHERE Name = 'claude.exe' OR Name = 'Claude.exe' OR Name = 'ClaudeOpenClient.exe'";
                var all = new System.Collections.Generic.Dictionary<int, int>();          // pid -> parentPid
                var cmdOf = new System.Collections.Generic.Dictionary<int, string>();      // pid -> commandLine
                using (var searcher = new System.Management.ManagementObjectSearcher(wql))
                using (var results = searcher.Get())
                {
                    foreach (System.Management.ManagementObject mo in results)
                    {
                        int pid; int ppid;
                        try { pid = Convert.ToInt32(mo["ProcessId"]); } catch { continue; }
                        try { ppid = Convert.ToInt32(mo["ParentProcessId"]); } catch { ppid = 0; }
                        string cmd = null; try { cmd = mo["CommandLine"] as string; } catch {}
                        all[pid] = ppid;
                        cmdOf[pid] = cmd ?? "";
                    }
                }

                // Find processes whose COMMAND LINE references OUR isolated profile.
                // Electron children carry --user-data-dir=<profile> on the command
                // line; the ROOT process may not (it gets the profile via the
                // environment block, which WMI does not expose). So we also walk UP
                // to the topmost Claude ancestor of each matched child and tree-kill
                // that root -- otherwise the root respawns the children we killed.
                var roots = new System.Collections.Generic.HashSet<int>();
                foreach (var kv in cmdOf)
                {
                    if (kv.Value.IndexOf(needle, StringComparison.OrdinalIgnoreCase) < 0) continue;
                    int cur = kv.Key;
                    // Walk up while the parent is ALSO one of our Claude processes.
                    int guard = 0;
                    while (all.ContainsKey(all[cur]) && guard++ < 32)
                    {
                        cur = all[cur];
                    }
                    roots.Add(cur); // topmost Claude ancestor
                }

                if (roots.Count == 0) return;
                foreach (int rootPid in roots)
                {
                    try
                    {
                        AppendLog("Tree-closing profile-scoped client root PID " + rootPid + "...");
                        // taskkill /T terminates the whole process tree, defeating
                        // Electron's respawn-from-root behavior. This root was reached
                        // ONLY by walking up from a process whose command line names
                        // OUR profile, so normal Claude (different profile) is never hit.
                        var psi = new ProcessStartInfo("taskkill.exe", "/PID " + rootPid + " /T /F")
                        {
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true,
                            RedirectStandardError = true
                        };
                        using (var tk = Process.Start(psi)) { tk.WaitForExit(5000); }
                    }
                    catch (Exception ex) { AppendLog("KillClientByProfile: taskkill root " + rootPid + " -> " + ex.Message); }
                }
            }
            catch (Exception ex)
            {
                // WMI unavailable or query failed: log and continue. The tracked
                // handle kill above still applies; we never fall back to a broad
                // image-name kill that could hit normal Claude.
                AppendLog("KillClientByProfile: WMI query failed (non-fatal): " + ex.Message);
            }
        }

        private void TestConnectionButton_Click(object sender, EventArgs e)
        {
            if (activePort == 0)
            {
                MessageBox.Show("Verify Gateway requires the adapter to be running. Launch first.", "Adapter Not Running", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            healthStatusLabel.Text = "Deep Health: Checking...";
            healthStatusLabel.ForeColor = ClaudeWarning;
            AppendLog("Requesting deep health check from adapter...");

            try
            {
                string url = "http://127.0.0.1:" + activePort + "/health/deep";
                HttpWebRequest request = (HttpWebRequest)WebRequest.Create(url);
                request.Timeout = 15000;
                ReadRuntimeState();
                request.Headers[HttpRequestHeader.Authorization] = "Bearer " + clientToken;

                using (HttpWebResponse response = (HttpWebResponse)request.GetResponse())
                {
                    if (response.StatusCode == HttpStatusCode.OK)
                    {
                        using (var reader = new StreamReader(response.GetResponseStream()))
                        {
                            string respBody = reader.ReadToEnd();
                            var state = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(respBody);
                            bool healthy = state.ContainsKey("healthy") && Convert.ToBoolean(state["healthy"]);
                            AppendLog("Deep health result: " + (healthy ? "healthy" : "unhealthy"));
                            healthStatusLabel.Text = "Deep Health: " + (healthy ? "Healthy" : "Unhealthy");
                            healthStatusLabel.ForeColor = healthy ? ClaudeSuccess : ClaudeDanger;
                            MessageBox.Show(healthy ? "Gateway discovery and real inference passed." : "One or more gateway health layers failed.", "Deep Health Checked", MessageBoxButtons.OK, healthy ? MessageBoxIcon.Information : MessageBoxIcon.Warning);
                        }
                    }
                    else
                    {
                        healthStatusLabel.Text = "Deep Health: Unhealthy";
                        healthStatusLabel.ForeColor = ClaudeDanger;
                    }
                }
            }
            catch (Exception ex)
            {
                AppendLog("Health check failed: " + ex.Message);
                healthStatusLabel.Text = "Deep Health: Connection Failed";
                healthStatusLabel.ForeColor = ClaudeDanger;
                MessageBox.Show("Verification failed: " + ex.Message, "Deep Health Checked", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }

        protected override void OnFormClosing(FormClosingEventArgs e)
        {
            stopping = true;
            StopProcesses();
            base.OnFormClosing(e);
        }

        // Helpers
        private int FindFreePort()
        {
            TcpListener l = new TcpListener(IPAddress.Loopback, 0);
            l.Start();
            int port = ((IPEndPoint)l.LocalEndpoint).Port;
            l.Stop();
            return port;
        }

        private string ComputeSha256(string rawData)
        {
            using (System.Security.Cryptography.SHA256 sha256Hash = System.Security.Cryptography.SHA256.Create())
            {
                byte[] bytes = sha256Hash.ComputeHash(Encoding.UTF8.GetBytes(rawData));
                StringBuilder builder = new StringBuilder();
                for (int i = 0; i < bytes.Length; i++)
                {
                    builder.Append(bytes[i].ToString("x2"));
                }
                return builder.ToString();
            }
        }

        private void ProtectDirectory(string path)
        {
            ProtectPath(path, true);
        }

        private void ProtectFile(string path)
        {
            ProtectPath(path, false);
        }

        private void ProtectPath(string path, bool directory)
        {
            try
            {
                SecurityIdentifier user = WindowsIdentity.GetCurrent().User;
                SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
                if (directory)
                {
                    DirectoryInfo info = new DirectoryInfo(path);
                    DirectorySecurity acl = info.GetAccessControl();
                    acl.SetAccessRuleProtection(true, false);
                    InheritanceFlags inherit = InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit;
                    acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                    acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, inherit, PropagationFlags.None, AccessControlType.Allow));
                    info.SetAccessControl(acl);
                }
                else
                {
                    FileInfo info = new FileInfo(path);
                    FileSecurity acl = info.GetAccessControl();
                    acl.SetAccessRuleProtection(true, false);
                    acl.AddAccessRule(new FileSystemAccessRule(user, FileSystemRights.FullControl, AccessControlType.Allow));
                    acl.AddAccessRule(new FileSystemAccessRule(system, FileSystemRights.FullControl, AccessControlType.Allow));
                    info.SetAccessControl(acl);
                }
            }
            catch { }
        }

        // Credential Manager Helper Functions
        public static bool WriteCredential(string target, string username, string password)
        {
            var cred = new CREDENTIAL();
            cred.Type = 1; // Generic
            cred.TargetName = target;
            cred.UserName = username;
            cred.Persist = 2; // Local machine

            byte[] passwordBytes = Encoding.Unicode.GetBytes(password);
            cred.CredentialBlobSize = passwordBytes.Length;
            IntPtr pin = Marshal.AllocCoTaskMem(passwordBytes.Length);
            Marshal.Copy(passwordBytes, 0, pin, passwordBytes.Length);
            cred.CredentialBlob = pin;

            try
            {
                return CredWrite(ref cred, 0);
            }
            finally
            {
                Marshal.FreeCoTaskMem(pin);
            }
        }

        public static bool DeleteCredential(string target)
        {
            return CredDelete(target, 1, 0);
        }

        public static string ReadCredential(string target)
        {
            IntPtr credPtr;
            if (CredRead(target, 1, 0, out credPtr))
            {
                try
                {
                    var cred = (CREDENTIAL)Marshal.PtrToStructure(credPtr, typeof(CREDENTIAL));
                    byte[] bytes = new byte[cred.CredentialBlobSize];
                    Marshal.Copy(cred.CredentialBlob, bytes, 0, cred.CredentialBlobSize);
                    return Encoding.Unicode.GetString(bytes);
                }
                finally
                {
                    CredFree(credPtr);
                }
            }
            return null;
        }
    }

    public static class TextBoxExtensions
    {
        private const int EM_SETCUEBANNER = 0x1501;

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern Int32 SendMessage(IntPtr hWnd, int msg, int wParam, [MarshalAs(UnmanagedType.LPWStr)] string lParam);

        public static void Watermark(this TextBox textBox, string watermarkText)
        {
            SendMessage(textBox.Handle, EM_SETCUEBANNER, 0, watermarkText);
        }
    }

    static class Program
    {
        private static Mutex singleInstance;
        [STAThread]
        static void Main()
        {
            bool created;
            singleInstance = new Mutex(true, "Local\\ClaudeOpen.ControlCenter", out created);
            if (!created)
            {
                MessageBox.Show("Claude Open is already running.", "Claude Open", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            Application.Run(new ClaudeOpenForm());
        }
    }
}
