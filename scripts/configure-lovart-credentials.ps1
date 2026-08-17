$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Lovart Key Setup"
$form.ClientSize = New-Object System.Drawing.Size(500, 285)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$title = New-Object System.Windows.Forms.Label
$title.Text = "Add or replace your Lovart keys"
$title.Font = New-Object System.Drawing.Font("Segoe UI", 15, [System.Drawing.FontStyle]::Bold)
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(28, 22)
$form.Controls.Add($title)

$help = New-Object System.Windows.Forms.Label
$help.Text = "Paste both new values from Lovart. They stay on this PC and are not sent to chat."
$help.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$help.AutoSize = $true
$help.Location = New-Object System.Drawing.Point(30, 58)
$form.Controls.Add($help)

$akLabel = New-Object System.Windows.Forms.Label
$akLabel.Text = "Access Key (AK)"
$akLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$akLabel.AutoSize = $true
$akLabel.Location = New-Object System.Drawing.Point(30, 92)
$form.Controls.Add($akLabel)

$akBox = New-Object System.Windows.Forms.TextBox
$akBox.Location = New-Object System.Drawing.Point(33, 113)
$akBox.Size = New-Object System.Drawing.Size(434, 27)
$akBox.UseSystemPasswordChar = $true
$form.Controls.Add($akBox)

$skLabel = New-Object System.Windows.Forms.Label
$skLabel.Text = "Secret Key (SK)"
$skLabel.Font = New-Object System.Drawing.Font("Segoe UI", 9)
$skLabel.AutoSize = $true
$skLabel.Location = New-Object System.Drawing.Point(30, 151)
$form.Controls.Add($skLabel)

$skBox = New-Object System.Windows.Forms.TextBox
$skBox.Location = New-Object System.Drawing.Point(33, 172)
$skBox.Size = New-Object System.Drawing.Size(434, 27)
$skBox.UseSystemPasswordChar = $true
$form.Controls.Add($skBox)

$cancelButton = New-Object System.Windows.Forms.Button
$cancelButton.Text = "Cancel"
$cancelButton.Size = New-Object System.Drawing.Size(92, 34)
$cancelButton.Location = New-Object System.Drawing.Point(273, 225)
$cancelButton.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($cancelButton)

$saveButton = New-Object System.Windows.Forms.Button
$saveButton.Text = "Save"
$saveButton.Size = New-Object System.Drawing.Size(92, 34)
$saveButton.Location = New-Object System.Drawing.Point(375, 225)
$form.Controls.Add($saveButton)

$saveButton.Add_Click({
    $accessKey = $akBox.Text.Trim()
    $secretKey = $skBox.Text.Trim()
    if ([string]::IsNullOrWhiteSpace($accessKey) -or [string]::IsNullOrWhiteSpace($secretKey)) {
        [System.Windows.Forms.MessageBox]::Show(
            "Please enter both AK and SK.",
            "Lovart Key Setup",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Warning
        ) | Out-Null
        return
    }

    try {
        [Environment]::SetEnvironmentVariable("LOVART_ACCESS_KEY", $accessKey, "User")
        [Environment]::SetEnvironmentVariable("LOVART_SECRET_KEY", $secretKey, "User")
        $akBox.Clear()
        $skBox.Clear()
        [System.Windows.Forms.MessageBox]::Show(
            "Saved. You can use Lovart immediately; no Codex restart is needed.",
            "Lovart Key Setup",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Information
        ) | Out-Null
        $form.Close()
    } catch {
        [System.Windows.Forms.MessageBox]::Show(
            "Could not save the keys: $($_.Exception.Message)",
            "Lovart Key Setup",
            [System.Windows.Forms.MessageBoxButtons]::OK,
            [System.Windows.Forms.MessageBoxIcon]::Error
        ) | Out-Null
    } finally {
        $accessKey = $null
        $secretKey = $null
    }
})

$form.AcceptButton = $saveButton
$form.CancelButton = $cancelButton
$form.Add_Shown({ $akBox.Focus() })
[void]$form.ShowDialog()
