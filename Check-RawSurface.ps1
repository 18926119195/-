$ErrorActionPreference = 'Stop'
$NewtonsoftPath = 'Z:\Newtonsoft.Json.dll'
Add-Type -Path $NewtonsoftPath

$FinalIndexPath = 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\final-noun-index.json'
$t = [System.IO.File]::ReadAllText($FinalIndexPath)
$o = [Newtonsoft.Json.Linq.JObject]::Parse($t)
$ns = $o['nouns']

# 统计 surface 以逗号+空格开头的条目（说明抽取阶段把逗号也吸收进了名词表面形式，
# 这类"名词"本身就是脏数据，不是需要合并审查判断的真实相邻名词对）
$commaLed = New-Object System.Collections.Generic.List[object]
foreach ($n in $ns) {
    $s = [string]$n['surface']
    if ($s.StartsWith(', ') -or $s.StartsWith(',')) { $commaLed.Add($s) }
}
Write-Output ("surfaces led by comma: " + $commaLed.Count + " / total nouns: " + $ns.Count)
Write-Output ("percentage: " + [math]::Round(100.0 * $commaLed.Count / $ns.Count, 2) + "%")
