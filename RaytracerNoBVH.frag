#version 140

// Useful Values
const float PI = 3.14159265359;
const float TWO_PI = 6.28318530718;
const float SMALL_VALUE = 0.01;
const float ALPHA_FULLBRIGHT = -1.0;
const vec3 PLANE_NORMAL = vec3( 0.0, -1.0, 0.0 );

// Ray parameters
const float NEAR_PLANE = 0.0;
const float FAR_PLANE = 10000.0;
const int MAX_VIEW_ITERATIONS = 3;
const int MAX_SHADOW_ITERATIONS = 1;

// Feature switches
const bool DISABLE_LIGHTING = false;
const bool DISABLE_SHADOWS = false;

// Object Type Enumerators
const int OBJECT_TYPE_NONE = -1;
const int OBJECT_TYPE_PLANE = 0;
const int OBJECT_TYPE_SPHERE = 1;
const int OBJECT_TYPE_DISC = 2;
const int OBJECT_TYPE_AABB = 3;
const int OBJECT_TYPE_CONVEXPOLY = 4;

// Material Type Enumerators
const int MATERIAL_TYPE_NONE = -1;
const int MATERIAL_TYPE_COLOR = 0;
const int MATERIAL_TYPE_TEXTURE = 1;
const int MATERIAL_TYPE_PORTAL = 2;
const int MATERIAL_TYPE_SPACEWARP = 3;

uniform vec2 WindowSize;
uniform float FOV;
uniform vec4 SkyColor;
uniform vec3 CameraPos;
uniform mat4 CameraRot;
uniform float AmbientIntensity;
uniform vec4 SkyLightColor;
uniform vec3 SkyLightDirection;
uniform int ObjectCount;
uniform int ObjectInfoSize;
uniform samplerBuffer PrimitiveSampler;
uniform samplerBuffer AccellStructureSampler;
uniform samplerBuffer CellObjectSampler;

// Screen coordinates from vertex shader
in vec2 ScreenCoord;

out vec4 color;

/*
 * Object structures
 */
struct ObjectMaterial
{
    int Type;
    vec4 Color;

    float Diffuse;
    float Specular;
    float SpecularFactor;
    float Emissive;

    float Reflection;
    float RefractiveIndex;
    float CastShadow;

    vec3 PortalOffset;
    vec3 PortalAxis;
    float PortalAngle;
};

struct Primitive
{
    int ID;
    int Type;
    mat4 WorldMatrix;
    mat4 InverseWorldMatrix;
    mat4 NormalMatrix;
    ObjectMaterial Material;
    float Sides;
};

struct Ray
{
    vec3 Origin;
    vec3 Direction;
    vec3 InverseDirection;
};

struct IsectData
{
    vec3 Position;
    vec3 Normal;
    float Backface;
};

struct RayData
{
    int HitID; // -1.0 = No hit, >= 0 = Hit Object ID
    ObjectMaterial HitMaterial;
    vec3 Position;
    vec3 Normal;
    float Backface;
    vec3 PortalPosition;
};

/*
 * Struct constructors
 */
ObjectMaterial constructObjectMaterial()
{
    return ObjectMaterial(
        MATERIAL_TYPE_NONE,
        vec4( 0.0 ),
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        0.0,
        vec3( 0.0 ),
        vec3( 0.0 ),
        0.0
    );
}

RayData constructRayData()
{
    return RayData(
        -1,
        constructObjectMaterial(),
        vec3( 0.0 ),
        vec3( 0.0 ),
        0.0,
        vec3( 0.0 )
    );
}

IsectData constructIsectData()
{
    return IsectData( vec3( 0.0 ), vec3( 0.0 ), 0.0 );
}

/*
 * Utility functions
 */
// Transforms a world-space ray into local primitive-space
Ray localRay( in Ray ray, in Primitive primitive )
{
    Ray lRay = ray;

    //Inverse transform the ray into primitive space
    lRay.Origin = vec3( primitive.InverseWorldMatrix * vec4( lRay.Origin, 1.0 ) );
    lRay.Direction = normalize( vec3( primitive.InverseWorldMatrix * vec4( lRay.Direction, 0.0 ) ) );
    lRay.InverseDirection = vec3( 1.0 ) / lRay.Direction;

    return lRay;
}

// Transforms a set of local intersection data into world-space
IsectData worldIsectData( in IsectData isectData, in Primitive primitive )
{
    IsectData wIsectData = isectData;

    // Transform the intersection data into world space
    wIsectData.Position = vec3( primitive.WorldMatrix * vec4( wIsectData.Position, 1.0 ) );
    wIsectData.Normal = normalize( vec3( primitive.NormalMatrix * vec4( wIsectData.Normal, 0.0 ) ) );

    return wIsectData;
}

// Creates a 4x4 rotation matrix from axis/angle
mat4 rotationMatrix( in vec3 axis, in float angle )
{
    vec3 nAxis = normalize( axis );
    float s = sin( angle );
    float c = cos( angle );
    float oc = 1.0 - c;

    return mat4( oc * nAxis.x * nAxis.x + c,           oc * nAxis.x * nAxis.y - nAxis.z * s, oc * nAxis.z * nAxis.x + nAxis.y * s, 0.0,
                 oc * nAxis.x * nAxis.y + nAxis.z * s, oc * nAxis.y * nAxis.y + c,           oc * nAxis.y * nAxis.z - nAxis.x * s, 0.0,
                 oc * nAxis.z * nAxis.x - nAxis.y * s, oc * nAxis.y * nAxis.z + nAxis.x * s, oc * nAxis.z * nAxis.z + c,           0.0,
                 0.0,                                  0.0,                                  0.0,                                  1.0 );
}

// Returns the cardinal ( unit ) direction vector of input vector v
vec3 cardinalDirection( in vec3 v )
{
    float mi = 0;
    float mv = 0;

    for( int i = 0; i < 3; ++i )
    {
        float avi = abs( v[ i ] );
        float diff = avi - mv;
        float f = clamp( sign( diff ), 0.0, 1.0 ); // diff > 0
        mv = mix( mv, avi, f );
        mi = mix( mi, i, f );
    }

    vec3 ov = vec3( 0.0 );
    ov[ int( mi ) ] = sign( v[ int( mi ) ] );

    return ov;
}

// Extracts and returns a 4x4 rotation matrix from a 1D buffer texture at offset i
mat4 extractMatrix( in int i )
{
    return mat4(
        texelFetch( PrimitiveSampler, i + 0 ),
        texelFetch( PrimitiveSampler, i + 1 ),
        texelFetch( PrimitiveSampler, i + 2 ),
        texelFetch( PrimitiveSampler, i + 3 )
    );
}

// Extracts and returns a Primitive from a 4D buffer texture at offset i
Primitive extractPrimitive( in int i )
{
    Primitive primitive;

    vec4 infoCell = texelFetch( PrimitiveSampler, i + 0 );
    // Object ID
    primitive.ID = int( infoCell[ 0 ] );
    // Object Type
    primitive.Type = int( infoCell[ 1 ] );

    // World Matrix ( 4 cells length )
    primitive.WorldMatrix = extractMatrix( i + 1 );

    // Inverse World Matrix ( 4 cells length )
    primitive.InverseWorldMatrix = extractMatrix( i + 5 );

    // Normal Matrix ( 4 cells length )
    primitive.NormalMatrix = extractMatrix( i + 9 );

    // Material
    // Type
    vec4 typeCell = texelFetch( PrimitiveSampler, i + 13 );
    primitive.Material.Type = int( typeCell[0] );

    // Color
    vec4 colorCell = texelFetch( PrimitiveSampler, i + 14 );
    primitive.Material.Color = colorCell;

    vec4 lightingCell = texelFetch( PrimitiveSampler, i + 15 );
    // Diffuse
    primitive.Material.Diffuse = lightingCell[0];

    // Specular
    primitive.Material.Specular = lightingCell[1];

    // Specular Factor
    primitive.Material.SpecularFactor = lightingCell[2];

    // Emissive
    primitive.Material.Emissive = lightingCell[3];

    vec4 effectsCell = texelFetch( PrimitiveSampler, i + 16 );
    // Reflection
    primitive.Material.Reflection = effectsCell[0];

    // Refractive Index
    primitive.Material.RefractiveIndex = effectsCell[1];

    // Shadow Casting
    primitive.Material.CastShadow = effectsCell[2];

    // Portal Transform
    vec4 portalOffsetCell = texelFetch( PrimitiveSampler, i + 17 );
    primitive.Material.PortalOffset = portalOffsetCell.xyz;

    vec4 portalAxisAngleCell = texelFetch( PrimitiveSampler, i + 18 );
    primitive.Material.PortalAxis = portalAxisAngleCell.xyz;
    primitive.Material.PortalAngle = portalAxisAngleCell.w;

    // Object-specific parameters
    // Sides
    vec4 sidesCell = texelFetch( PrimitiveSampler, i + 19 );
    primitive.Sides = sidesCell[0];

    return primitive;
}

/*
 * Point containment functions
 */
float sphereContainsLocal( in Primitive sphere, in vec3 pt )
{
    float hit = 1.0;

    float dist = dot( pt, pt );
    hit = mix( hit, 0.0, step( 1.0, dist ) );

    return hit;
}

float sphereContainsWorld( in Primitive sphere, in vec3 pt )
{
    float hit = 1.0;

    vec3 localPt = vec3( sphere.InverseWorldMatrix * vec4( pt, 1.0 ) );
    float dist = dot( localPt, localPt );
    hit = mix( hit, 0.0, step( 1.0, dist ) );

    return hit;
}

float aabbContainsLocal( in Primitive aabb, in vec3 pt )
{
    float hit = 1.0;

    for( int i = 0; i < 3; ++i )
    {
        hit = mix( 0.0, hit, step( -0.5, pt[ i ] ) ); // pt[ i ] >= -0.5
        hit = mix( 0.0, hit, step( pt[ i ], 0.5 ) ); // pt[ i ] < 0.5
    }

    return hit;
}

float aabbContainsWorld( in Primitive aabb, in vec3 pt )
{
    float hit = 1.0;

    vec3 localPt = vec3( aabb.InverseWorldMatrix * vec4( pt, 1.0 ) );

    for( int i = 0; i < 3; ++i )
    {
        hit = mix( 0.0, hit, step( -0.5, localPt[ i ] ) ); // localPt[ i ] >= -0.5
        hit = mix( 0.0, hit, step( localPt[ i ], 0.5 ) ); // localPt[ i ] < 0.5
    }

    return hit;
}

/*
 * Ray-primitive intersection functions
 */
float isectSphere(
    in Ray ray,
    in Primitive primitive,
    inout IsectData isectData
    )
{
    float hit = 1.0;
    float backface = sphereContainsLocal( primitive, ray.Origin );

    vec3 l = -ray.Origin;
    float tca = dot( l, ray.Direction );

    float ds = dot( l, l ) - tca * tca;
    hit = step( ds, 1.0 );

    float thc = sqrt( 1.0 - ds );

    float t0 = tca - thc; // Entry t
    float t1 = tca + thc; // Exit t

    float t = mix( t0, t1, backface );

    hit = mix( 0.0, hit, step( NEAR_PLANE, t ) );

    isectData.Position = mix( isectData.Position, ray.Origin + ( ray.Direction * t ), hit );
    isectData.Normal = mix( isectData.Normal, normalize( isectData.Position ) * mix( 1.0, -1.0, backface ), hit );
    isectData.Backface = backface;

    return hit;
}

float isectPlane(
    in Ray ray,
    in Primitive primitive,
    inout IsectData isectData
    )
{
    float hit = 1.0;

    vec3 pn = PLANE_NORMAL;

    float ndr = dot( pn, ray.Direction );
    hit = mix( 0.0, hit, ceil( abs( ndr ) ) ); // ndr == 0.0

    float t = -dot( pn, ray.Origin ) / dot( pn, ray.Direction );

    hit = mix( 0.0, hit, step( NEAR_PLANE, t ) ); // t >= NEAR_PLANE

    isectData.Position = mix( isectData.Position, ray.Origin + ( ray.Direction * t ), hit );
    isectData.Normal = mix( isectData.Normal, pn * -sign( ndr ), hit );

    return hit;
}

float isectDisc(
    in Ray ray,
    in Primitive primitive,
    inout IsectData isectData
    )
{
    float hit = 1.0;

    vec3 dn = PLANE_NORMAL;

    // Plane intersection test
    float ndr = dot( dn, ray.Direction );
    hit = mix( 0.0, hit, ceil( abs( ndr ) ) ); // ndr == 0.0

    float t = -( dot( dn, ray.Origin ) - dot( dn, vec3( 0 ) ) ) / dot( dn, ray.Direction );

    hit = mix( 0.0, hit, step( NEAR_PLANE, t ) );

    // Disc intersection test
    vec3 pp = ray.Origin + ( ray.Direction * t );
    float d = dot( pp, pp );
    hit = mix( hit, 0.0, step( 1.0, d ) ); // d > primitive.Scale^2

    isectData.Position = mix( isectData.Position, ray.Origin + ( ray.Direction * t ), hit );
    isectData.Normal = mix( isectData.Normal, dn * -sign( ndr ), hit );

    return hit;
}

float isectAABB(
    in Ray ray,
    in Primitive primitive,
    inout IsectData isectData
    )
{
    float hit = 1.0;
    float backface = aabbContainsLocal( primitive, ray.Origin );

    // Calculate intersection using the slab method ( clip ray against box per-axis )
    vec3 t0 = ( vec3( 0.5 ) - ray.Origin ) * ray.InverseDirection;
    vec3 t1 = ( vec3(-0.5 ) - ray.Origin ) * ray.InverseDirection;
    float tmin = min( t0.x, t1.x );
    float tmax = max( t0.x, t1.x );
    tmin = max( tmin, min( t0.y, t1.y ) );
    tmax = min( tmax, max( t0.y, t1.y ) );
    tmin = max( tmin, min( t0.z, t1.z ) );
    tmax = min( tmax, max( t0.z, t1.z ) );
    hit = step( tmin, tmax );

    // Check hit against ray limits
    float t = mix( tmin, tmax, backface );
    hit = mix( 0.0, hit, step( NEAR_PLANE, t ) );

    vec3 pt = ray.Origin + ( ray.Direction * t ) ;

    isectData.Position = mix( isectData.Position, pt, hit );
    isectData.Normal = mix( isectData.Normal, cardinalDirection( pt ) * mix( 1.0, -1.0, backface ), hit );
    isectData.Backface = backface;

    return hit;
}

float isectConvexPoly(
    in Ray ray,
    in Primitive primitive,
    inout IsectData isectData
    )
{
    float hit = 1.0;

    vec3 pn = PLANE_NORMAL;
    // Plane intersection test
    float ndr = dot( pn, ray.Direction );
    //IF ( ndr == 0.0 ) hit = 0.0;
    hit = mix( 0.0, hit, ceil( abs( ndr ) ) );
    //ENDIF

    float t = -( dot( pn, ray.Origin ) - dot( pn, vec3( 0 ) ) ) / dot( pn, ray.Direction );
    hit = mix( 0.0, hit, step( NEAR_PLANE, t ) );

    // Poly intersection test
    vec3 pt = ray.Origin + ( ray.Direction * t ) ;

    vec3 bv = vec3( 0.0, 0.0, 1.0 );
    bv = normalize( vec3( rotationMatrix( vec3( 0.0, 1.0, 0.0 ), PI / primitive.Sides ) * vec4( bv, 1.0 ) ) );

    for( int i = 0; i < int( primitive.Sides ); ++i )
    {
        vec3 v0 = bv;

        bv = normalize( vec3( rotationMatrix( vec3( 0.0, 1.0, 0.0 ), TWO_PI / primitive.Sides ) * vec4( bv, 1.0 ) ) );
        vec3 v1 = bv;

        vec3 edge = normalize( v1 - v0 );

        vec3 c = normalize( pt - v0 );
        hit = mix( 0.0, hit, step( 0.0, dot( pn, cross( edge, c ) ) ) ); // dot( pn, cross( edge, c ) ) < 0.0
    }

    isectData.Position = mix( isectData.Position, ray.Origin + ( ray.Direction * t ), hit );
    isectData.Normal = mix( isectData.Normal, pn * -sign( ndr ), hit );

    return hit;
}

float isectPrimitive(
        in Ray ray,
        in Primitive primitive,
        inout IsectData isectData
    )
{
    float hit = 0.0;
    switch( primitive.Type )
    {
        case OBJECT_TYPE_SPHERE:
            hit = isectSphere( ray, primitive, isectData );
            break;
        case OBJECT_TYPE_PLANE:
            hit = isectPlane( ray, primitive, isectData );
            break;
        case OBJECT_TYPE_DISC:
            hit = isectDisc( ray, primitive, isectData );
            break;
        case OBJECT_TYPE_AABB:
            hit = isectAABB( ray, primitive, isectData );
            break;
        case OBJECT_TYPE_CONVEXPOLY:
            hit = isectConvexPoly( ray, primitive, isectData );
            break;
        default:
            break;
    }

    return hit;
}

/*
 * Ray/Intersection utility functions
 */
// Check primitives for any solid spacewarps, if the ray's origin is inside then warp it's direction
void checkWarp(
    inout Ray ray
)
{
    vec3 warpFactor = vec3( 1.0 );

    for( int i = 0; i < ObjectCount; ++i )
    {
        // Retrieve primitive parameters from texture buffer
        Primitive primitive = extractPrimitive( ( i * ObjectInfoSize ) );

        // Test for intersection with appropriately configured primitive
        switch( primitive.Type )
        {
            case OBJECT_TYPE_SPHERE:
                if( primitive.Material.Type == MATERIAL_TYPE_SPACEWARP )
                {
                    warpFactor = mix( warpFactor, primitive.Material.PortalOffset, sphereContainsWorld( primitive, ray.Origin ) );
                }
                break;
            case OBJECT_TYPE_AABB:
                if( primitive.Material.Type == MATERIAL_TYPE_SPACEWARP )
                {
                    warpFactor = mix( warpFactor, primitive.Material.PortalOffset, aabbContainsWorld( primitive, ray.Origin ) );
                }
                break;
            default:
                break;
        }
    }

    ray.Direction = normalize( ray.Direction * warpFactor );
    ray.InverseDirection = vec3( 1.0 ) / ray.Direction;
}

// Loads intersection data into a ray data structure upon successful collision
void primitiveIntersection(
    in Primitive primitive,
    in IsectData isectData,
    inout RayData rayData
)
{
    rayData.HitID = primitive.ID;
    rayData.HitMaterial = primitive.Material;
    rayData.Position = isectData.Position;
    rayData.Normal = isectData.Normal;
    rayData.Backface = isectData.Backface;

    if( primitive.Material.Type == MATERIAL_TYPE_TEXTURE )
    {
        rayData.HitMaterial.Color = vec4( clamp( tan( rayData.Position ) * 0.8, 0.0, 1.0 ), 1.0 ) * primitive.Material.Color;
    }

    if( primitive.Material.Type == MATERIAL_TYPE_PORTAL )
    {
        rayData.PortalPosition = vec3( primitive.WorldMatrix * vec4( 0.0, 0.0, 0.0, 1.0 ) );
    }
}

// Reflects a ray about a given hit point and normal
void reflectRay(
        inout Ray ray,
        in vec3 hitPosition,
        in vec3 hitNormal
    )
{
    ray.Origin = hitPosition + hitNormal * SMALL_VALUE;
    ray.Direction = reflect( ray.Direction, hitNormal );
    ray.InverseDirection = vec3( 1.0 ) / ray.Direction;
}

// Refracts a ray about a given hit point and normal at the given refractive index
void refractRay(
        inout Ray ray,
        in vec3 hitPosition,
        in vec3 hitNormal,
        in float refractiveIndex
    )
{
    ray.Origin = hitPosition - hitNormal * SMALL_VALUE;
    ray.Direction = refract( -ray.Direction, hitNormal, refractiveIndex );
    ray.InverseDirection = vec3( 1.0 ) / ray.Direction;
}

// Trasforms a ray through a portal based on the given offset and orientation
void portalRay(
        inout Ray ray,
        in vec3 hitPosition,
        in vec3 hitNormal,
        in vec3 portalPosition,
        in vec3 portalOffset,
        in vec3 portalRotAxis,
        in float portalRotAngle
    )
{
    mat4 portalRotation = mat4( 1.0 );
    if( portalRotAngle != 0.0 )
    {
        portalRotation = rotationMatrix( portalRotAxis, portalRotAngle );
    }
    vec3 outNormal = vec3( portalRotation * vec4( hitNormal, 1.0 ) );
    vec3 inOriginRelative = hitPosition - portalPosition;
    vec3 inOriginRelativeRotated = vec3( portalRotation * vec4( inOriginRelative, 1.0 ) );

    ray.Origin = inOriginRelativeRotated + ( portalPosition + portalOffset ) - outNormal * SMALL_VALUE;
    ray.Direction = normalize( vec3( portalRotation * vec4( ray.Direction, 1.0 ) ) );
    ray.InverseDirection = vec3( 1.0 ) / ray.Direction;

    // NOTE: Works when exit portal is inside warp, undesired behavior when exit is out of warp
    //checkWarp( ray );
}

// Warps a ray about a given intersection at the given warp factor
void warpRay(
        inout Ray ray,
        in vec3 hitPosition,
        in vec3 hitNormal,
        in vec3 warpFactor,
        in float backface
    )
{
    ray.Origin = hitPosition - hitNormal * SMALL_VALUE;
    if( backface == 0.0 )
    {
        ray.Direction = normalize( ray.Direction * warpFactor );
    }
    else
    {
        ray.Direction = normalize( ray.Direction *  ( vec3( 1.0 ) / warpFactor ) );
    }
    ray.InverseDirection = vec3( 1.0 ) / ray.Direction;
}

// Check if the ray has intersected a primitive, if so setup it's new origin and direction based on the hit material
bool checkRecast(
        inout Ray ray,
        in RayData rayData
    )
{
    bool recast = false;

    if( rayData.HitID > -1 )
    {
        // Transparency ( Limited to the recursion depth, but hey-ho )
        if( rayData.HitMaterial.Type <= MATERIAL_TYPE_TEXTURE && rayData.HitMaterial.Color.w < 1.0 )
        {
            // Nudge the ray through the primitive by a small amount to prevent re-collision
            ray.Origin = rayData.Position - rayData.Normal * SMALL_VALUE;
            recast = true;
        }

        // Reflection
        if( rayData.HitMaterial.Type <= MATERIAL_TYPE_TEXTURE && rayData.HitMaterial.Reflection > 0.0 )
        {
            reflectRay( ray, rayData.Position, rayData.Normal );
            recast = true;
        }

        // Refraction
        if( rayData.HitMaterial.Type <= MATERIAL_TYPE_TEXTURE && rayData.HitMaterial.RefractiveIndex != 1.0 )
        {
            refractRay( ray, rayData.Position, rayData.Normal, rayData.HitMaterial.RefractiveIndex );
            recast = true;
        }

        // Portal
        if( rayData.HitMaterial.Type == MATERIAL_TYPE_PORTAL )
        {
            portalRay(
                ray,
                rayData.Position,
                rayData.Normal,
                rayData.PortalPosition,
                rayData.HitMaterial.PortalOffset,
                rayData.HitMaterial.PortalAxis,
                rayData.HitMaterial.PortalAngle
            );
            recast = true;
        }

        // Spacewarp
        if( rayData.HitMaterial.Type == MATERIAL_TYPE_SPACEWARP )
        {
            warpRay( ray, rayData.Position, rayData.Normal, rayData.HitMaterial.PortalOffset, rayData.Backface );
            recast = true;
        }
    }

    return recast;
}

// Casts a ray, checks for any collisions and reiterates to the specified level
void castRay(
    in Ray ray,
    in int iterations,
    out RayData rayData
    )
{
    rayData = constructRayData();

    checkWarp( ray );

    int[ MAX_VIEW_ITERATIONS ] hitIDs;
    ObjectMaterial[ MAX_VIEW_ITERATIONS ] hitMaterials;

    for( int i = 0; i < MAX_VIEW_ITERATIONS; ++i )
    {
        hitIDs[ i ] = -1;
        hitMaterials[ i ] = constructObjectMaterial();
    }

    // Outer loop - Ray iterations (Recasts - Reflection, Refraction, Portals, Spacewarp)
    for( int o = 0; o < iterations; ++o )
    {
        float nearest = FAR_PLANE * FAR_PLANE; // Using dist^2 to avoid sqrt

        // Inner loop - Per-primitive iterations
        for( int i = 0; i < ObjectCount; ++i )
        {
            // Prepare primitive to be tested, local-space ray and intersection data
            Primitive primitive = extractPrimitive( ( i * ObjectInfoSize ) );
            Ray lRay = localRay( ray, primitive );
            IsectData isectData = constructIsectData();

            // Test for intersection
            if( isectPrimitive( lRay, primitive, isectData ) == 1.0 )
            {
                isectData = worldIsectData( isectData, primitive );

                // Calculate distance
                vec3 diff = isectData.Position - ray.Origin;
                float dist = dot( diff, diff );

                // If closer than current nearest, update the output data
                if( dist < nearest )
                {
                    nearest = dist;
                    primitiveIntersection( primitive, isectData, rayData );
                    hitIDs[o] = rayData.HitID;
                    hitMaterials[o] = rayData.HitMaterial;
                }
            }
        }

        if( !checkRecast( ray, rayData ) ) break;
    }

    // Iterate through hit materials and sum color
    vec4 outColor = vec4( 0.0 );
    int prevHitID;
    for( int i = 0; i < MAX_VIEW_ITERATIONS; i++ )
    {
        if( hitMaterials[i].Type <= MATERIAL_TYPE_TEXTURE )
        {
            float alpha = hitMaterials[i].Color.w;
            outColor.xyz += mix( hitMaterials[i].Color.xyz * alpha, vec3( 0.0 ), step( 1.0, outColor.w ) );
            outColor.w += mix( alpha, 0.0, step( 1.0, outColor.w ) );
        }
        prevHitID = hitIDs[i];
    }
    rayData.HitMaterial.Color = outColor;
}

/*
 * Entry Point
 */
void main()
{
    // Calculate ray direction
    vec2 screenPos = ( ScreenCoord - 0.5 ) * 2;
    float ar = WindowSize.x / WindowSize.y;
    float xMag = screenPos.x * ( ar / tan( FOV * 0.5 ) );
    float yMag = screenPos.y * ( 1.0 / tan( FOV * 0.5 ) );

    vec3 rayDirection = normalize( vec3( xMag, yMag,-1.0 ) );
    rayDirection = vec3( CameraRot * vec4( rayDirection, 0.0 ) );

    // Primary ray intersection
    Ray primaryRay = Ray( CameraPos, rayDirection, vec3( 1.0 ) / rayDirection );
    RayData primaryRayData;

    castRay( primaryRay, MAX_VIEW_ITERATIONS, primaryRayData );

    // Shadow ray intersection
    vec3 shadowRayDirection = normalize( SkyLightDirection );
    Ray secondaryRay = Ray(
        primaryRayData.Position + ( primaryRayData.Normal * SMALL_VALUE ),
        shadowRayDirection,
        vec3( 1.0 ) / shadowRayDirection
    );
    RayData shadowRayData;

    if( DISABLE_SHADOWS == false )
    {
        castRay( secondaryRay, MAX_SHADOW_ITERATIONS, shadowRayData );
    }

    if( primaryRayData.HitID > -1.0 )
    {
        float brightness = 1.0;

        if( DISABLE_LIGHTING == false )
        {
            float df = max( 0.0, dot( primaryRayData.Normal, SkyLightDirection ) );
            df *= primaryRayData.HitMaterial.Diffuse;

            float sf = 0.0;
            vec3 hitToEye = normalize( primaryRayData.Position - CameraPos );
            vec3 LightReflect = reflect( SkyLightDirection, primaryRayData.Normal );
            sf = clamp( dot( hitToEye, LightReflect ), 0.0, 1.0 );
            sf = pow( sf, primaryRayData.HitMaterial.SpecularFactor );
            sf *= primaryRayData.HitMaterial.Specular;

            brightness = sf + df;
        }

        float ambientEmissive = AmbientIntensity + primaryRayData.HitMaterial.Emissive;
        brightness = mix( brightness + ambientEmissive, ambientEmissive, shadowRayData.HitID > -1 && shadowRayData.HitMaterial.CastShadow == 1.0 );

        primaryRayData.HitMaterial.Color.xyz *= SkyLightColor.xyz;
        primaryRayData.HitMaterial.Color.xyz *= brightness;
    }

    // Clamp color values to 1.0 to prevent wrapping
    primaryRayData.HitMaterial.Color = min( primaryRayData.HitMaterial.Color, 1.0 );

    color = primaryRayData.HitMaterial.Color;
}