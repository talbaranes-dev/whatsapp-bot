Do
    Set WshShell = CreateObject("WScript.Shell")
    WshShell.Run "cmd /c cd /d C:\Users\talba\OneDrive\Desktop\34A8~1 && node index.js", 0, True
    WScript.Sleep 5000
Loop
