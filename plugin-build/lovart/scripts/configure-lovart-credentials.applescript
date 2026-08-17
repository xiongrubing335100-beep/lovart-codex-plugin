use scripting additions

set serviceName to "com.lovart.codex"
set accessAccount to "LOVART_ACCESS_KEY"
set secretAccount to "LOVART_SECRET_KEY"

try
	set accessDialog to display dialog "Enter your Lovart Access Key (AK)." default answer "" with hidden answer
	set accessKey to text returned of accessDialog
	if accessKey is "" then
		display alert "The Access Key cannot be blank." as warning
		return
	end if

	set secretDialog to display dialog "Enter your Lovart Secret Key (SK)." default answer "" with hidden answer
	set secretKey to text returned of secretDialog
	if secretKey is "" then
		display alert "The Secret Key cannot be blank." as warning
		return
	end if

	do shell script "/usr/bin/security add-generic-password -U -s " & quoted form of serviceName & " -a " & quoted form of accessAccount & " -w " & quoted form of accessKey
	do shell script "/usr/bin/security add-generic-password -U -s " & quoted form of serviceName & " -a " & quoted form of secretAccount & " -w " & quoted form of secretKey
	display dialog "Lovart keys saved in your macOS Keychain." with title "Lovart Key Setup" buttons {"OK"} default button "OK"
on error number -128
	return
on error
	display alert "Lovart keys could not be saved to the macOS Keychain." as critical
end try
