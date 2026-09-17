$ErrorActionPreference = 'Stop'
$NewtonsoftPath = 'Z:\Newtonsoft.Json.dll'
Add-Type -Path $NewtonsoftPath

$FinalIndexPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\final-noun-index.json'
$t = [System.IO.File]::ReadAllText($FinalIndexPath)
$o = [Newtonsoft.Json.Linq.JObject]::Parse($t)
$ns = $o['nouns']

$hits = New-Object System.Collections.Generic.List[object]
foreach ($n in $ns) {
    $s = [string]$n['surface']
    if ($s.StartsWith(',')) { $hits.Add($s) }
}
Write-Output ("surfaces starting with comma: " + $hits.Count)
$i = 0
foreach ($h in $hits) {
    if ($i -ge 10) { break }
    Write-Output ("  [" + $h + "]")
    $i++
}
