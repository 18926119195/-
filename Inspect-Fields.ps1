$obj = Get-Content 'C:\Users\Administrator\Desktop\decide-design-v2-datacleaning-20260916-2151-main\adjacency-analysis-result.json' -Raw | ConvertFrom-Json
$obj.strictCandidates[0] | Format-List *
