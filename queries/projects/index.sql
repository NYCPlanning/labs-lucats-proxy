SELECT 
  dcp_name,
  dcp_projectname,
  dcp_projectbrief
FROM dcp_project p
WHERE dcp_validatedcommunitydistricts ILIKE '%${communityDistrict:value}%'
ORDER BY dcp_name ASC
LIMIT ${itemsPerPage:value} OFFSET ${offset:value}
