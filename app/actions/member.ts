'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'

import { getServerTranslations } from '@/lib/i18n/server'
import { getProfile, getSupabase } from '@/utils/supabase/queries'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export async function deleteMemberProfile(memberId: string) {
  const { t } = await getServerTranslations()
  if (!UUID_PATTERN.test(memberId)) {
    return { error: t('invalidProfile') }
  }

  const profile = await getProfile()
  const supabase = await getSupabase()

  if (
    !profile?.is_active ||
    (profile.role !== 'admin' && profile.role !== 'editor')
  ) {
    return {
      error: t('memberDeleteAccessDenied')
    }
  }

  // 2. Check for existing relationships
  const { data: relationships, error: relationshipError } = await supabase
    .from('relationships')
    .select('id')
    .or(`person_a.eq.${memberId},person_b.eq.${memberId}`)
    .limit(1)

  if (relationshipError) {
    console.error('Error checking relationships:', relationshipError)
    return { error: t('relationshipCheckError') }
  }

  if (relationships && relationships.length > 0) {
    return {
      error: t('memberHasRelationships')
    }
  }

  // 3. Delete the member
  const { error: deleteError } = await supabase
    .from('persons')
    .delete()
    .eq('id', memberId)

  if (deleteError) {
    console.error('Error deleting person:', deleteError)
    return { error: t('memberDeleteError') }
  }

  // 4. Revalidate and redirect
  revalidatePath('/dashboard/members')
  redirect('/dashboard/members')
}

export async function updateDescendantGenerationsAction(
  personId: string,
  generationDelta: number
) {
  const { t } = await getServerTranslations()
  if (!UUID_PATTERN.test(personId)) {
    return { error: t('invalidProfile') }
  }

  if (
    generationDelta === 0 ||
    !Number.isInteger(generationDelta) ||
    Math.abs(generationDelta) > 100
  ) {
    return generationDelta === 0
      ? { success: true }
      : { error: t('invalidGenerationDelta') }
  }

  const profile = await getProfile()
  const supabase = await getSupabase()

  if (
    !profile?.is_active ||
    (profile.role !== 'admin' && profile.role !== 'editor')
  ) {
    return {
      error: t('memberEditAccessDenied')
    }
  }

  // 1. Fetch current person's saved generation
  const { data: currentPerson, error: personError } = await supabase
    .from('persons')
    .select('id, generation')
    .eq('id', personId)
    .single()

  if (personError || !currentPerson) {
    return { error: t('generationsFetchError') }
  }

  const baseGen = currentPerson.generation

  // 2. Fetch parent-child and marriage relationships
  const { data: relationships, error: relError } = await supabase
    .from('relationships')
    .select('person_a, person_b, type')
    .in('type', ['biological_child', 'adopted_child', 'marriage'])

  if (relError) {
    console.error('Error fetching relationships:', relError)
    return { error: t('relationshipsFetchError') }
  }

  // Build children and spouses maps
  const childrenMap = new Map<string, string[]>()
  const spousesMap = new Map<string, string[]>()

  relationships.forEach((r) => {
    if (r.type === 'marriage') {
      if (!spousesMap.has(r.person_a)) spousesMap.set(r.person_a, [])
      if (!spousesMap.has(r.person_b)) spousesMap.set(r.person_b, [])
      spousesMap.get(r.person_a)!.push(r.person_b)
      spousesMap.get(r.person_b)!.push(r.person_a)
    } else if (r.type === 'biological_child' || r.type === 'adopted_child') {
      if (!childrenMap.has(r.person_a)) childrenMap.set(r.person_a, [])
      childrenMap.get(r.person_a)!.push(r.person_b)
    }
  })

  // 3. Level-by-level BFS traversal
  // targetGenMap stores personId -> expected generation
  const targetGenMap = new Map<string, number>()
  const visited = new Set<string>()
  visited.add(personId)

  // Level 0: Spouses of personId (vợ chồng thì bằng đời với mình)
  const directSpouses = spousesMap.get(personId) || []
  for (const s of directSpouses) {
    if (!visited.has(s)) {
      visited.add(s)
      if (baseGen != null) {
        targetGenMap.set(s, Math.max(1, baseGen))
      }
    }
  }

  // Parents for the next generation level: personId and their spouses
  let currentLevelParents = [personId, ...directSpouses]
  let currentDepth = 0

  while (currentLevelParents.length > 0) {
    currentDepth++
    const levelGeneration =
      baseGen != null ? Math.max(1, baseGen + currentDepth) : null

    // Find all children born to the parents at current level (con cái = đời mình + currentDepth)
    const nextLevelChildren: string[] = []
    for (const parentId of currentLevelParents) {
      const children = childrenMap.get(parentId) || []
      for (const childId of children) {
        if (!visited.has(childId)) {
          visited.add(childId)
          nextLevelChildren.push(childId)
          if (levelGeneration != null) {
            targetGenMap.set(childId, levelGeneration)
          }
        }
      }
    }

    if (nextLevelChildren.length === 0) break

    // Find all spouses of the children at this level (dâu/rể thì bằng đời với người phối ngẫu)
    const nextLevelSpouses: string[] = []
    for (const childId of nextLevelChildren) {
      const sps = spousesMap.get(childId) || []
      for (const spId of sps) {
        if (!visited.has(spId)) {
          visited.add(spId)
          nextLevelSpouses.push(spId)
          if (levelGeneration != null) {
            targetGenMap.set(spId, levelGeneration)
          }
        }
      }
    }

    // Next level parents include both children and their spouses
    currentLevelParents = [...nextLevelChildren, ...nextLevelSpouses]
  }

  // If baseGen is null (no generation specified), fallback to shifting existing values by generationDelta
  if (baseGen == null) {
    const otherIds = Array.from(visited).filter((id) => id !== personId)
    if (otherIds.length === 0) return { success: true }

    const { data: fallbackPersons, error: fallbackError } = await supabase
      .from('persons')
      .select('id, generation')
      .in('id', otherIds)

    if (fallbackError) {
      console.error('Error fetching fallback persons:', fallbackError)
      return { error: t('generationsFetchError') }
    }

    let hasError = false
    for (const p of fallbackPersons) {
      if (p.generation != null) {
        const newGen = Math.max(1, p.generation + generationDelta)
        const { error: updateError } = await supabase
          .from('persons')
          .update({ generation: newGen })
          .eq('id', p.id)
        if (updateError) hasError = true
      }
    }

    if (hasError) return { error: t('descendantGenerationUpdateError') }

    revalidatePath('/dashboard/members')
    revalidatePath('/dashboard/tree')
    return { success: true }
  }

  const idsToUpdate = Array.from(targetGenMap.keys())
  if (idsToUpdate.length === 0) return { success: true }

  // 4. Fetch current generations to only update those that differ
  const { data: persons, error: personsError } = await supabase
    .from('persons')
    .select('id, generation')
    .in('id', idsToUpdate)

  if (personsError) {
    console.error('Error fetching persons:', personsError)
    return { error: t('generationsFetchError') }
  }

  // 5. Update each target person's generation
  let hasError = false
  for (const person of persons) {
    const expectedGen = targetGenMap.get(person.id)
    if (expectedGen !== undefined && person.generation !== expectedGen) {
      const { error: updateError } = await supabase
        .from('persons')
        .update({ generation: expectedGen })
        .eq('id', person.id)

      if (updateError) {
        console.error(`Error updating person ${person.id}:`, updateError)
        hasError = true
      }
    }
  }

  if (hasError) {
    return { error: t('descendantGenerationUpdateError') }
  }

  revalidatePath('/dashboard/members')
  revalidatePath('/dashboard/tree')

  return { success: true }
}
