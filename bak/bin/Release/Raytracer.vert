#version 140

in vec3 vertex;

void main(void) {
        gl_Position = vec4(vertex, 1.0);
}